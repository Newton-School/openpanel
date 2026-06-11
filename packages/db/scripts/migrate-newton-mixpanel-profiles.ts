/**
 * migrate-newton-mixpanel-profiles
 * --------------------------------
 * One-off loader: transform parked Mixpanel profiles into OpenPanel identified
 * profiles (P1) and write them to the ClickHouse `profiles` table — reusing
 * OpenPanel's OWN code (`ch`, `chQuery`, `toDots`, the `profiles` schema /
 * argMax fetch) so the result is byte-for-byte what the live import path writes.
 *
 * Phase-1 export already parked the raw Mixpanel data in S3. Before running,
 * sync the inputs to a local dir (the script is intentionally S3-free so it
 * adds no deps to the monorepo):
 *
 *   aws s3 sync  s3://newton-mixpanel-migration/newton-school/profiles/  /data/profiles/
 *   aws s3 cp    s3://newton-mixpanel-migration/identity/newton-school/mixpanel_email_uid.json /data/gap.json
 *
 * Then, somewhere with CLICKHOUSE_URL in env + network to the OpenPanel CH:
 *
 *   CLICKHOUSE_URL=... pnpm jiti ./scripts/migrate-newton-mixpanel-profiles.ts \
 *     --dir /data/profiles --gap /data/gap.json --project-id <PLATFORM_PROJECT_ID> [flags]
 *
 * Identity (settled in design): OpenPanel profile_id (identified) =
 *   newton UserProfile.uid = Mixpanel profile property `userId`.
 *   Profiles that don't resolve to a uid (leads/anon) are SKIPPED — P1 = identified only.
 *
 * Merge policy (settled in design):
 *   - Within Mixpanel: multiple profiles can point to one uid. Fold them
 *     freshest-`$last_seen`-wins, older profiles only fill missing keys (union).
 *   - Against OpenPanel: the existing OP value WINS on conflict (OP is recent),
 *     Mixpanel only fills gaps. created_at is bumped +1ms over the existing row so
 *     our write wins the ReplacingMergeTree(created_at) de-dup.
 *
 * Safety / staged-rollout controls:
 *   --dry-run            transform + group only; never touch ClickHouse
 *   --sample N           (dry-run) print N built rows so you can eyeball the transform
 *   --limit N            cap profiles SCANNED from disk (fast iteration)
 *   --only uid[,uid...]  restrict the whole run to specific uid(s)
 *   --new-only           insert ONLY uids absent from OpenPanel (skip existing)
 *   --max-insert N       stop after N profiles actually inserted
 *   --show-rows          print every row as it is inserted (live)
 *
 * Single-profile smoke test (1 profile that's in Mixpanel but NOT in OpenPanel):
 *   ... --new-only --max-insert 1 --show-rows --batch 200
 * Full P1 mass import (after verification):
 *   ... --project-id <PLATFORM_PROJECT_ID>
 */
import { createReadStream } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { parseArgs } from 'node:util';
import { createGunzip } from 'node:zlib';
import { toDots } from '@openpanel/common';
import { TABLE_NAMES, ch, chQuery } from '../src/clickhouse/client';
import type { IClickhouseProfile } from '../src/services/profile.service';

// ---- args ----------------------------------------------------------------
const { values } = parseArgs({
  options: {
    dir: { type: 'string' }, // local dir of page-*.jsonl.gz
    gap: { type: 'string' }, // local mixpanel_email_uid.json
    'project-id': { type: 'string' },
    batch: { type: 'string', default: '5000' },
    'dry-run': { type: 'boolean', default: false },
    sample: { type: 'string' }, // dry-run: print N built rows (MP-only)
    limit: { type: 'string' }, // cap profiles scanned
    only: { type: 'string' }, // comma-sep uids to restrict to
    'new-only': { type: 'boolean', default: false }, // insert only uids absent from OP
    'max-insert': { type: 'string' }, // stop after N inserted
    'show-rows': { type: 'boolean', default: false }, // print each inserted row
  },
  strict: true,
});

const DIR = values.dir;
const GAP_PATH = values.gap;
const PROJECT_ID = values['project-id'];
const BATCH = Number.parseInt(values.batch ?? '5000', 10);
const DRY_RUN = values['dry-run'] ?? false;
const LIMIT = values.limit ? Number.parseInt(values.limit, 10) : Number.POSITIVE_INFINITY;
const ONLY = values.only
  ? new Set(values.only.split(',').map((s) => s.trim()).filter(Boolean))
  : null;
const NEW_ONLY = values['new-only'] ?? false;
const MAX_INSERT = values['max-insert']
  ? Number.parseInt(values['max-insert'], 10)
  : Number.POSITIVE_INFINITY;
const SHOW_ROWS = values['show-rows'] ?? false;

if (!DIR || !GAP_PATH || !PROJECT_ID) {
  console.error('required: --dir <profiles dir> --gap <gap.json> --project-id <id>');
  process.exit(1);
}

// ---- transform constants (mirror of the validated Go loader) -------------

// junk / internal / promoted profile keys — dropped from the property map
// because they become dedicated columns or carry no value.
const DROP_KEYS = new Set([
  '$distinct_id', '$distint_id', '$userid', '$avatar', '$image',
  '$first_name', '$last_name',
  '$mp_api_endpoint', '$mp_api_timestamp_ms', '$import',
  'userId',                 // -> id
  '$email', 'email',        // -> email column
  '$name',                  // -> first/last name
]);

type Props = Record<string, unknown>;

const firstStr = (p: Props, ...keys: string[]): string => {
  for (const k of keys) {
    const v = p[k];
    if (typeof v === 'string' && v !== '') return v;
  }
  return '';
};

/** strip leading '$', drop junk/$mp_, flatten via OpenPanel's toDots → Map(String,String). */
function cleanProps(props: Props): Record<string, string> {
  const obj: Props = {};
  for (const [k, v] of Object.entries(props)) {
    if (DROP_KEYS.has(k) || k.startsWith('$mp_')) continue;
    obj[k.startsWith('$') ? k.slice(1) : k] = v;
  }
  return toDots(obj); // same flatten the live import path applies
}

/** $last_seen ("2024-11-02T08:48:09", no tz) → unix seconds; 0 if absent/unparseable. */
function lastSeenSec(v: unknown): number {
  if (typeof v !== 'string' || v === '') return 0;
  const ms = Date.parse(v.endsWith('Z') || /[+-]\d\d:?\d\d$/.test(v) ? v : `${v}Z`);
  return Number.isNaN(ms) ? 0 : Math.floor(ms / 1000);
}

// ---- identity ------------------------------------------------------------
type GapMap = Map<string, string>; // email | "u:"+username -> newton uid

function resolveUid(props: Props, gap: GapMap): string {
  const own = props.userId;
  if (typeof own === 'string' && own !== '') return own;
  const email = firstStr(props, '$email', 'email');
  if (email) {
    const hit = gap.get(email.trim().toLowerCase());
    if (hit) return hit;
  }
  const uname = firstStr(props, '$username', 'username');
  if (uname) {
    const hit = gap.get(`u:${uname}`);
    if (hit) return hit;
  }
  return '';
}

// ---- per-uid fold-merge --------------------------------------------------
// Order-independent freshest-wins + union: a profile whose $last_seen >= the
// current max overlays its values; an older one only fills missing keys.
class Merged {
  props: Record<string, string> = {};
  maxSeen = -1;
  email = '';
  fullName = '';

  fold(raw: Props) {
    const kept = cleanProps(raw);
    const email = firstStr(raw, '$email', 'email');
    const fullName = firstStr(raw, '$name');
    const seen = lastSeenSec(raw.$last_seen);
    const fresher = seen >= this.maxSeen;

    for (const [k, v] of Object.entries(kept)) {
      if (fresher || !(k in this.props)) this.props[k] = v;
    }
    if (fresher) {
      if (email) this.email = email;
      if (fullName) this.fullName = fullName;
      this.maxSeen = seen;
    } else {
      if (!this.email) this.email = email;
      if (!this.fullName) this.fullName = fullName;
    }
  }
}

const splitName = (n: string): [string, string] => {
  n = n.trim();
  const i = n.indexOf(' ');
  return i > 0 ? [n.slice(0, i), n.slice(i + 1).trim()] : [n, ''];
};

// ---- existing-profile fetch (mirror of ProfileBuffer's argMax, no date filter) ----
type Existing = {
  first_name: string; last_name: string; email: string; avatar: string;
  is_external: boolean; properties: Record<string, string>; created_at: string;
};

async function fetchExisting(ids: string[]): Promise<Map<string, Existing>> {
  const out = new Map<string, Existing>();
  if (ids.length === 0) return out;
  const idList = ids.map((id) => `'${id.replace(/'/g, "\\'")}'`).join(',');
  const rows = await chQuery<Existing & { id: string }>(`
    SELECT id,
      argMax(nullIf(first_name, ''), ${TABLE_NAMES.profiles}.created_at) as first_name,
      argMax(nullIf(last_name, ''),  ${TABLE_NAMES.profiles}.created_at) as last_name,
      argMax(nullIf(email, ''),      ${TABLE_NAMES.profiles}.created_at) as email,
      argMax(nullIf(avatar, ''),     ${TABLE_NAMES.profiles}.created_at) as avatar,
      argMax(is_external,            ${TABLE_NAMES.profiles}.created_at) as is_external,
      argMax(properties,             ${TABLE_NAMES.profiles}.created_at) as properties,
      max(created_at) as created_at
    FROM ${TABLE_NAMES.profiles}
    WHERE project_id = '${PROJECT_ID}' AND id IN (${idList})
    GROUP BY id`);
  for (const r of rows) {
    out.set(r.id, {
      first_name: r.first_name ?? '', last_name: r.last_name ?? '',
      email: r.email ?? '', avatar: r.avatar ?? '',
      is_external: !!r.is_external, properties: r.properties ?? {},
      created_at: r.created_at,
    });
  }
  return out;
}

// CH DateTime64(3) literal: 'YYYY-MM-DD HH:MM:SS.mmm' (date_time_input_format=best_effort).
const fmtCH = (d: Date): string => d.toISOString().replace('T', ' ').replace('Z', '');

// OP-wins merge → the 9 real `profiles` columns (table has no `groups` column).
function build(uid: string, m: Merged, existing?: Existing): Omit<IClickhouseProfile, 'groups'> {
  const props: Record<string, string> = { ...m.props }; // Mixpanel as base
  let email = m.email;
  let fullName = m.fullName;
  let createdAt = new Date((m.maxSeen > 0 ? m.maxSeen : 0) * 1000);

  if (existing) {
    for (const [k, v] of Object.entries(existing.properties)) {
      if (v !== '') props[k] = v; // OP wins on conflict, MP fills gaps
    }
    if (existing.email) email = existing.email;
    if (existing.first_name || existing.last_name) {
      fullName = `${existing.first_name} ${existing.last_name}`.trim();
    }
    const exAt = new Date(`${existing.created_at.replace(' ', 'T')}Z`);
    if (!Number.isNaN(exAt.getTime()) && exAt.getTime() >= createdAt.getTime()) {
      createdAt = new Date(exAt.getTime() + 1); // win RMT(created_at) over existing
    }
  }

  const [first, last] = splitName(fullName);
  return {
    id: uid,
    is_external: false, // identified users (matches live)
    first_name: first,
    last_name: last,
    email,
    avatar: '',
    properties: props,
    project_id: PROJECT_ID!,
    created_at: fmtCH(createdAt),
  };
}

// ---- main ----------------------------------------------------------------
async function main() {
  console.log(`[gap] loading ${GAP_PATH}`);
  const gapObj = JSON.parse(await readFile(GAP_PATH!, 'utf8')) as Record<string, string>;
  const gap: GapMap = new Map(Object.entries(gapObj));
  console.log(`[gap] ${gap.size} entries`);

  const files = (await readdir(DIR!))
    .filter((f) => f.startsWith('page-') && f.endsWith('.jsonl.gz'))
    .sort();
  console.log(`[scan] ${files.length} page files in ${DIR}`);

  const merged = new Map<string, Merged>();
  let total = 0;
  let resolved = 0;

  outer: for (const f of files) {
    const rl = createInterface({
      input: createReadStream(`${DIR}/${f}`).pipe(createGunzip()),
      crlfDelay: Number.POSITIVE_INFINITY,
    });
    for await (const line of rl) {
      if (!line) continue;
      if (total >= LIMIT) { rl.close(); break outer; }
      total++;
      let rec: { $properties?: Props };
      try {
        rec = JSON.parse(line);
      } catch {
        continue;
      }
      const props = rec.$properties;
      if (!props) continue;
      const uid = resolveUid(props, gap);
      if (!uid) continue; // P1: identified only
      if (ONLY && !ONLY.has(uid)) continue;
      resolved++;
      let m = merged.get(uid);
      if (!m) {
        m = new Merged();
        merged.set(uid, m);
      }
      m.fold(props);
    }
    console.log(`[scan] ${f}  total=${total} resolved=${resolved} uids=${merged.size}`);
  }
  console.log(`[grouped] mp_profiles=${total} resolved=${resolved} unique_uids=${merged.size}`);

  if (ONLY) {
    const missing = [...ONLY].filter((u) => !merged.has(u));
    console.log(`[only] ${merged.size}/${ONLY.size} requested uids present in Mixpanel` +
      (missing.length ? ` (missing: ${missing.join(',')})` : ''));
  }

  if (DRY_RUN) {
    const n = values.sample ? Number.parseInt(values.sample, 10) : 0;
    for (const uid of [...merged.keys()].slice(0, n)) {
      console.log('[sample]', JSON.stringify(build(uid, merged.get(uid)!), null, 2));
    }
    console.log('[dry-run] skipping ClickHouse writes');
    return;
  }

  const uids = [...merged.keys()];
  let written = 0;
  let skippedExisting = 0;
  for (let i = 0; i < uids.length && written < MAX_INSERT; i += BATCH) {
    const ids = uids.slice(i, i + BATCH);
    const existing = await fetchExisting(ids);

    let rows = ids
      .filter((uid) => !(NEW_ONLY && existing.has(uid)))
      .map((uid) => build(uid, merged.get(uid)!, existing.get(uid)));
    skippedExisting += ids.length - rows.length;

    const room = MAX_INSERT - written;
    if (rows.length > room) rows = rows.slice(0, room);
    if (rows.length === 0) continue;

    if (SHOW_ROWS) for (const r of rows) console.log('[row]', JSON.stringify(r));
    await ch.insert({ table: TABLE_NAMES.profiles, values: rows, format: 'JSONEachRow' });
    written += rows.length;

    if (MAX_INSERT !== Number.POSITIVE_INFINITY || (i / BATCH) % 10 === 0) {
      const denom = MAX_INSERT !== Number.POSITIVE_INFINITY ? MAX_INSERT : uids.length;
      console.log(`[insert] written=${written}/${denom} skippedExisting=${skippedExisting}`);
    }
  }
  console.log(`[DONE] profiles_written=${written} skipped_existing=${skippedExisting}`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });

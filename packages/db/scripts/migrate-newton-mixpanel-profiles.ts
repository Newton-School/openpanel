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
 * is_external = TRUE for every migrated row: OpenPanel's getProfileName() renders
 *   any profile with is_external=false as "Anonymous" regardless of name/email;
 *   true = an identified (externally-keyed) user. The Mixpanel importer does the same.
 *
 * Merge policy (settled in design):
 *   - Within Mixpanel: multiple profiles can point to one uid. Fold them
 *     freshest-`$last_seen`-wins, older profiles only fill missing keys (union).
 *   - Against OpenPanel: the existing OP value WINS on conflict (OP is recent),
 *     Mixpanel only fills gaps. created_at is bumped +1ms over the existing row so
 *     our write wins the ReplacingMergeTree(created_at) de-dup.
 *
 * Every migrated row carries properties['__mp_migrated']='1' — provenance AND the
 * resume signal (see --resume).
 *
 * Throughput / safety controls (full run):
 *   --concurrency N      N concurrent fetch+insert pipelines (default 1)
 *   --control PATH       JSON {"rowsPerSec":N,"paused":bool} re-read before every
 *                        batch; a shared token bucket caps the AGGREGATE insert rate
 *                        across workers. Back it with a ConfigMap mounted as a dir
 *                        (not subPath) so `kubectl edit cm loader-control` propagates
 *                        live (~60s) with no restart. rowsPerSec<=0 / missing = unlimited.
 *   --resume             skip uids already migrated, by exact per-uid check of the
 *                        '__mp_migrated' marker (read for free from each batch's
 *                        existing-profile fetch). Robust to stray/out-of-order prior
 *                        inserts — no frontier/monotonicity assumption.
 *   --marker KEY         provenance/resume property key (default __mp_migrated)
 *
 * Staged-rollout / debug controls:
 *   --dry-run / --sample N / --limit N / --only uid,uid / --new-only / --max-insert N / --show-rows
 *
 * Single-profile smoke test (1 profile in Mixpanel but NOT in OpenPanel):
 *   ... --new-only --max-insert 1 --show-rows --batch 200
 * Full P1 import (after verification):
 *   ... --concurrency 6 --control /control/control.json --resume
 */
import { createReadStream, readFileSync } from 'node:fs';
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
    dir: { type: 'string' },
    gap: { type: 'string' },
    'project-id': { type: 'string' },
    batch: { type: 'string', default: '5000' },
    concurrency: { type: 'string', default: '1' },
    control: { type: 'string' },
    resume: { type: 'boolean', default: false },
    marker: { type: 'string', default: '__mp_migrated' },
    'dry-run': { type: 'boolean', default: false },
    sample: { type: 'string' },
    limit: { type: 'string' },
    only: { type: 'string' },
    'new-only': { type: 'boolean', default: false },
    'max-insert': { type: 'string' },
    'show-rows': { type: 'boolean', default: false },
  },
  strict: true,
});

const DIR = values.dir;
const GAP_PATH = values.gap;
const PROJECT_ID = values['project-id'];
const BATCH = Number.parseInt(values.batch ?? '5000', 10);
const CONCURRENCY = Math.max(1, Number.parseInt(values.concurrency ?? '1', 10));
const CONTROL_PATH = values.control;
const RESUME = values.resume ?? false;
const MARKER = values.marker ?? '__mp_migrated';
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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---- transform constants -------------------------------------------------
const DROP_KEYS = new Set([
  '$distinct_id', '$distint_id', '$userid', '$avatar', '$image',
  '$first_name', '$last_name',
  '$mp_api_endpoint', '$mp_api_timestamp_ms', '$import',
  'userId',                 // -> id column
  'email',                  // plain dup; OP uses $email + the email column
]);

// Mixpanel "people" props that OpenPanel's Newton integration stores VERBATIM
// (with the leading $). Keep them as-is so we match OP's keys instead of creating
// $-stripped dups (our `phone` vs OP's `$phone`). The email/first/last-name COLUMNS
// are still derived from $email/$name separately (see Merged.fold) — these are the
// redundant property copies native profiles also carry, so segments on
// properties['$phone'|'$email'|...] hit migrated users too.
const PRESERVE_DOLLAR = new Set(['$phone', '$email', '$name', '$username']);

type Props = Record<string, unknown>;

const firstStr = (p: Props, ...keys: string[]): string => {
  for (const k of keys) {
    const v = p[k];
    if (typeof v === 'string' && v !== '') return v;
  }
  return '';
};

// Mixpanel's country lives under $country_code (profiles) / $country / mp_country_code,
// but OpenPanel's geo display (SerieIcon flag, header) keys off a property named
// `country` with the ISO-2 value (matches the importer's transformEvent mapping).
// Other geo keys ($city->city, $region->region) already match after the $-strip.
const COUNTRY_SRC = ['$country_code', '$country', 'mp_country_code'];

function cleanProps(props: Props): Record<string, string> {
  const obj: Props = {};
  for (const [k, v] of Object.entries(props)) {
    if (DROP_KEYS.has(k) || k.startsWith('$mp_')) continue;
    if (COUNTRY_SRC.includes(k)) continue;            // -> `country` below
    if (PRESERVE_DOLLAR.has(k)) { obj[k] = v; continue; } // $phone/$email/$name/$username verbatim
    obj[k.startsWith('$') ? k.slice(1) : k] = v;      // $city->city, $os->os, ... (match OP enrichment)
  }
  const country = firstStr(props, ...COUNTRY_SRC);
  if (country) obj.country = country; // ISO-2; SerieIcon lowercases for the flag
  return toDots(obj);
}

function lastSeenSec(v: unknown): number {
  if (typeof v !== 'string' || v === '') return 0;
  const ms = Date.parse(v.endsWith('Z') || /[+-]\d\d:?\d\d$/.test(v) ? v : `${v}Z`);
  return Number.isNaN(ms) ? 0 : Math.floor(ms / 1000);
}

// ---- identity ------------------------------------------------------------
type GapMap = Map<string, string>;

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

  props[MARKER] = '1'; // provenance + resume marker, set last so it always survives

  const [first, last] = splitName(fullName);
  return {
    id: uid,
    is_external: true, // identified user — false renders as "Anonymous" in the UI
    first_name: first,
    last_name: last,
    email,
    avatar: '',
    properties: props,
    project_id: PROJECT_ID!,
    created_at: fmtCH(createdAt),
  };
}

// ---- live rate control (shared token bucket, ConfigMap-backed) -----------
const control = { rowsPerSec: 0, paused: false };

function applyControl() {
  if (!CONTROL_PATH) return;
  try {
    const c = JSON.parse(readFileSync(CONTROL_PATH, 'utf8'));
    if (typeof c.rowsPerSec === 'number') control.rowsPerSec = c.rowsPerSec;
    if (typeof c.paused === 'boolean') control.paused = c.paused;
  } catch {
    /* keep last good values if the file is mid-write or absent */
  }
}

const bucket = {
  tokens: 0,
  last: Date.now(),
  // acquire n row-tokens; honors live rowsPerSec + paused. Safe under concurrency
  // because token math runs synchronously between awaits (single JS thread).
  async acquire(n: number) {
    while (control.paused) await sleep(1000);
    const rate = control.rowsPerSec;
    if (!rate || rate <= 0) return; // unlimited
    for (;;) {
      const now = Date.now();
      this.tokens = Math.min(rate, this.tokens + ((now - this.last) / 1000) * rate);
      this.last = now;
      if (this.tokens >= n) { this.tokens -= n; return; }
      await sleep(Math.min(1000, ((n - this.tokens) / rate) * 1000));
    }
  },
};

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
      if (!uid) continue;
      if (ONLY && !ONLY.has(uid)) continue;
      resolved++;
      let m = merged.get(uid);
      if (!m) { m = new Merged(); merged.set(uid, m); }
      m.fold(props);
    }
    console.log(`[scan] ${f}  total=${total} resolved=${resolved} uids=${merged.size}`);
  }
  console.log(`[grouped] mp_profiles=${total} resolved=${resolved} unique_uids=${merged.size}`);

  if (ONLY) {
    const missing = [...ONLY].filter((u) => !merged.has(u));
    console.log(`[only] ${merged.size}/${ONLY.size} requested uids present` +
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

  // Deterministic order (stable batching run-to-run).
  const uids = [...merged.keys()].sort();
  if (RESUME) {
    console.log(`[resume] on — exact per-uid skip of profiles already marked '${MARKER}'. ` +
      `Robust to stray/out-of-order prior inserts (no frontier assumption).`);
  }

  // Workers pull batches off a shared cursor.
  const batchStarts: number[] = [];
  for (let i = 0; i < uids.length; i += BATCH) batchStarts.push(i);

  let written = 0;
  let skippedExisting = 0;
  let skippedDone = 0;
  let cursor = 0;
  applyControl();

  async function worker() {
    for (;;) {
      const bi = cursor++;
      if (bi >= batchStarts.length || written >= MAX_INSERT) return;
      const start = batchStarts[bi]!;
      const ids = uids.slice(start, start + BATCH);
      applyControl(); // pick up live rowsPerSec / paused

      const existing = await fetchExisting(ids);
      const rows: Array<Omit<IClickhouseProfile, 'groups'>> = [];
      for (const uid of ids) {
        const ex = existing.get(uid);
        if (NEW_ONLY && ex) { skippedExisting++; continue; }
        if (RESUME && ex?.properties?.[MARKER] === '1') { skippedDone++; continue; }
        const row = build(uid, merged.get(uid)!, ex);
        if (SHOW_ROWS) {
          if (ex) {
            console.log('[existing]', JSON.stringify({
              id: uid, is_external: ex.is_external, first_name: ex.first_name,
              last_name: ex.last_name, email: ex.email, properties: ex.properties,
              created_at: ex.created_at,
            }));
          }
          console.log('[row]', JSON.stringify(row)); // OP-wins result (compare to [existing])
        }
        rows.push(row);
      }

      const room = MAX_INSERT - written;
      const toWrite = rows.length > room ? rows.slice(0, room) : rows;
      if (toWrite.length === 0) continue;

      await bucket.acquire(toWrite.length);
      await ch.insert({ table: TABLE_NAMES.profiles, values: toWrite, format: 'JSONEachRow' });
      written += toWrite.length;

      if (bi % 20 === 0 || MAX_INSERT !== Number.POSITIVE_INFINITY) {
        const denom = MAX_INSERT !== Number.POSITIVE_INFINITY ? MAX_INSERT : uids.length;
        console.log(`[insert] written=${written}/${denom} skippedExisting=${skippedExisting} ` +
          `skippedDone=${skippedDone} rate=${control.rowsPerSec || 'unl'}${control.paused ? ' PAUSED' : ''}`);
      }
    }
  }

  console.log(`[load] ${batchStarts.length} batches of ${BATCH}, concurrency=${CONCURRENCY}, ` +
    `control=${CONTROL_PATH ?? 'none'}, resume=${RESUME}`);
  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

  console.log(`[DONE] profiles_written=${written} skipped_existing=${skippedExisting} skipped_done=${skippedDone}`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });

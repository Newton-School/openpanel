/**
 * migrate-newton-mixpanel-events
 * ------------------------------
 * Load IDENTIFIED Mixpanel events (newton-school) into the OpenPanel `events` table,
 * reusing the importer's transformEvent (OP-canonical: UA/referrer/geo/path/__query.utm/
 * $mp_web_page_view->screen_view/__source_insert_id) with three OVERRIDES:
 *   - profile_id  -> resolved newton uid (events carry email/username, never the uid)
 *   - created_at  -> (Mixpanel time - tzShift) ; export `time` is project-tz (IST) epoch
 *   - imported_at -> now (provenance)
 *
 * DUPLICATE PREVENTION: only events with created_at < --cutoff (OpenPanel's oldest event,
 * 2026-04-30) are loaded — the pre-OP era, zero overlap. The intersection window is a
 * separate later pass. Anonymous events (no resolvable uid) are skipped (also later).
 *
 * IDEMPOTENCY: one --month per run = one CH partition (toYYYYMM(created_at)). Pre-cutoff
 * partitions are EXCLUSIVELY ours, so a redo = --drop-partition (ALTER TABLE events DROP
 * PARTITION) + reload. NEVER use --drop-partition for an intersection-window month.
 *
 * Prep:
 *   aws s3 cp s3://.../newton-school/events/<month>-01_*.jsonl.gz /data/events/
 *   aws s3 cp s3://.../identity/newton-school/event_identity.json /data/event_identity.json
 * Run (analyze, no writes):
 *   pnpm jiti ./scripts/migrate-newton-mixpanel-events.ts --dir /data/events --month 2022-12 \
 *     --identity /data/event_identity.json --project-id platform --dry-run --sample 2
 * Run (load one month):
 *   ... --concurrency 8 --batch 5000 --control /control/control.json --drop-partition
 */
import { createReadStream, readFileSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { parseArgs } from 'node:util';
import { createGunzip } from 'node:zlib';
import { TABLE_NAMES, ch } from '../src/clickhouse/client';

// MixpanelProvider.transformEvent is loaded LAZILY (only on the real-insert path) via a
// relative import into the importer source. It pulls in @openpanel/common/server ->
// ua-parser -> lru-cache; the dry-run analysis below never touches it, so the analysis
// runs cleanly under jiti. (Real-insert transform-under-jiti is resolved separately.)
async function loadProvider(projectId: string) {
  const mod = await import('../../importer/src/providers/mixpanel');
  return new mod.MixpanelProvider(projectId, { mapScreenViewProperty: undefined } as any);
}

const { values } = parseArgs({
  options: {
    dir: { type: 'string' },
    month: { type: 'string' }, // YYYY-MM (selects the <month>-01_*.jsonl.gz chunk)
    identity: { type: 'string' },
    'project-id': { type: 'string' },
    cutoff: { type: 'string', default: '2026-04-30T00:00:00Z' }, // OP oldest event
    'tz-shift': { type: 'string', default: '19800' }, // IST->UTC seconds
    batch: { type: 'string', default: '5000' },
    concurrency: { type: 'string', default: '8' },
    control: { type: 'string' },
    'drop-partition': { type: 'boolean', default: false },
    'dry-run': { type: 'boolean', default: false },
    sample: { type: 'string' },
    limit: { type: 'string' },
    'max-insert': { type: 'string' },
  },
  strict: true,
});

const DIR = values.dir;
const MONTH = values.month;
const PROJECT_ID = values['project-id'];
const CUTOFF_MS = Date.parse(values.cutoff!);
const TZ_SHIFT_MS = Number.parseInt(values['tz-shift'] ?? '19800', 10) * 1000;
const BATCH = Number.parseInt(values.batch ?? '5000', 10);
const CONCURRENCY = Math.max(1, Number.parseInt(values.concurrency ?? '8', 10));
const DRY_RUN = values['dry-run'] ?? false;
const SAMPLE = values.sample ? Number.parseInt(values.sample, 10) : 0;
const LIMIT = values.limit ? Number.parseInt(values.limit, 10) : Number.POSITIVE_INFINITY;
const MAX_INSERT = values['max-insert'] ? Number.parseInt(values['max-insert'], 10) : Number.POSITIVE_INFINITY;

if (!DIR || !MONTH || !PROJECT_ID || !values.identity) {
  console.error('required: --dir <events dir> --month YYYY-MM --identity <map.json> --project-id <id>');
  process.exit(1);
}
if (Number.isNaN(CUTOFF_MS)) {
  console.error(`bad --cutoff: ${values.cutoff}`);
  process.exit(1);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---- live rate control (shared token bucket, same as profile loader) -----
const control = { rowsPerSec: 0, paused: false };
function applyControl() {
  if (!values.control) return;
  try {
    const c = JSON.parse(readFileSync(values.control, 'utf8'));
    if (typeof c.rowsPerSec === 'number') control.rowsPerSec = c.rowsPerSec;
    if (typeof c.paused === 'boolean') control.paused = c.paused;
  } catch {
    /* keep last good */
  }
}
const bucket = {
  tokens: 0,
  last: Date.now(),
  async acquire(n: number) {
    while (control.paused) await sleep(1000);
    const rate = control.rowsPerSec;
    if (!rate || rate <= 0) return;
    for (;;) {
      const now = Date.now();
      this.tokens = Math.min(rate, this.tokens + ((now - this.last) / 1000) * rate);
      this.last = now;
      if (this.tokens >= n) { this.tokens -= n; return; }
      await sleep(Math.min(1000, ((n - this.tokens) / rate) * 1000));
    }
  },
};

// ---- identity resolution (email / username -> uid) ------------------------
type Props = Record<string, any>;
const lc = (s: unknown) => (typeof s === 'string' ? s.trim().toLowerCase() : '');

function resolveUid(props: Props, idmap: Map<string, string>): string {
  const email = lc(props.$user_id); // $user_id is the email
  if (email && email.includes('@')) {
    const hit = idmap.get(email);
    if (hit) return hit;
  }
  // username candidates: distinct_id (unless it's a $device: anon id) + currentUserIdentifier
  const di = props.distinct_id;
  if (typeof di === 'string' && di && !di.startsWith('$device:')) {
    const hit = idmap.get(`u:${di}`);
    if (hit) return hit;
  }
  const cui = props.currentUserIdentifier;
  if (typeof cui === 'string' && cui) {
    const hit = idmap.get(`u:${cui}`);
    if (hit) return hit;
  }
  // last resort: distinct_id might itself be an email
  if (typeof di === 'string' && di.includes('@')) {
    const hit = idmap.get(lc(di));
    if (hit) return hit;
  }
  return '';
}

const fmtCH = (ms: number): string => new Date(ms).toISOString().replace('T', ' ').replace('Z', '');

// Events table columns only (drop IClickhouseEvent extras like groups/profile/meta).
function toRow(ev: any) {
  return {
    id: ev.id,
    name: ev.name,
    sdk_name: ev.sdk_name,
    sdk_version: ev.sdk_version,
    device_id: ev.device_id,
    profile_id: ev.profile_id,
    project_id: ev.project_id,
    session_id: ev.session_id ?? '',
    path: ev.path ?? '',
    origin: ev.origin ?? '',
    referrer: ev.referrer ?? '',
    referrer_name: ev.referrer_name ?? '',
    referrer_type: ev.referrer_type ?? '',
    duration: ev.duration ?? 0,
    properties: ev.properties ?? {},
    created_at: ev.created_at,
    country: ev.country ?? '',
    city: ev.city ?? '',
    region: ev.region ?? '',
    longitude: ev.longitude ?? null,
    latitude: ev.latitude ?? null,
    os: ev.os ?? '',
    os_version: ev.os_version ?? '',
    browser: ev.browser ?? '',
    browser_version: ev.browser_version ?? '',
    device: ev.device ?? '',
    brand: ev.brand ?? '',
    model: ev.model ?? '',
    imported_at: ev.imported_at ?? null,
  };
}

async function main() {
  const idmap = new Map<string, string>(
    Object.entries(JSON.parse(await readFile(values.identity!, 'utf8')) as Record<string, string>),
  );
  console.log(`[identity] ${idmap.size} keys`);

  // locate the month chunk file: <month>-01_*.jsonl.gz
  const files = (await readdir(DIR!)).filter((f) => f.startsWith(`${MONTH}-01_`) && f.endsWith('.jsonl.gz'));
  if (files.length !== 1) {
    console.error(`expected exactly one chunk for ${MONTH} in ${DIR}, found: ${files.join(', ') || '(none)'}`);
    process.exit(1);
  }
  const file = `${DIR}/${files[0]}`;
  console.log(`[file] ${file}  cutoff=${values.cutoff}  tzShift=${TZ_SHIFT_MS / 1000}s  dryRun=${DRY_RUN}`);

  const provider = DRY_RUN ? null : await loadProvider(PROJECT_ID!);

  // pre-insert idempotency for a real per-month reload (pre-cutoff partitions are ours).
  if (!DRY_RUN && values['drop-partition']) {
    const part = MONTH!.replace('-', ''); // YYYYMM
    console.log(`[drop] ALTER TABLE ${TABLE_NAMES.events} DROP PARTITION '${part}'`);
    await ch.command({ query: `ALTER TABLE ${TABLE_NAMES.events} DROP PARTITION '${part}'` });
  }

  let total = 0;
  let resolved = 0;
  let byEmail = 0;
  let byUser = 0;
  let anon = 0;
  let afterCutoff = 0;
  let parseErr = 0;
  let xformErr = 0;
  let written = 0;
  let samples = 0;

  const inflight = new Set<Promise<void>>();
  let batch: any[] = [];
  applyControl();

  async function flush() {
    if (batch.length === 0) return;
    const rows = batch;
    batch = [];
    applyControl();
    await bucket.acquire(rows.length);
    const p = ch
      .insert({ table: TABLE_NAMES.events, values: rows, format: 'JSONEachRow' })
      .then(() => {
        written += rows.length;
        if (written % (BATCH * 20) < BATCH) {
          console.log(`[insert] written=${written} resolved=${resolved} anon=${anon} afterCutoff=${afterCutoff} rate=${control.rowsPerSec || 'unl'}${control.paused ? ' PAUSED' : ''}`);
        }
      })
      .finally(() => { inflight.delete(p); });
    inflight.add(p);
    if (inflight.size >= CONCURRENCY) await Promise.race(inflight);
  }

  const rl = createInterface({
    input: createReadStream(file).pipe(createGunzip()),
    crlfDelay: Number.POSITIVE_INFINITY,
  });
  outer: for await (const line of rl) {
    if (!line) continue;
    if (total >= LIMIT) break;
    total++;
    let rec: { event?: string; properties?: Props };
    try {
      rec = JSON.parse(line);
    } catch {
      parseErr++;
      continue;
    }
    const props = rec.properties;
    if (!props || !rec.event) { parseErr++; continue; }

    const uid = resolveUid(props, idmap);
    if (!uid) { anon++; continue; }

    const t = props.time;
    const createdMs = typeof t === 'number' ? t * 1000 - TZ_SHIFT_MS : Number.NaN;
    if (!Number.isNaN(createdMs) && createdMs >= CUTOFF_MS) { afterCutoff++; continue; }

    resolved++;
    // track which key resolved (for the analysis)
    if (lc(props.$user_id).includes('@') && idmap.get(lc(props.$user_id)) === uid) byEmail++;
    else byUser++;

    if (DRY_RUN) {
      if (samples < SAMPLE) {
        samples++;
        console.log('[sample]', JSON.stringify({
          event: rec.event,
          uid,
          email: lc(props.$user_id),
          distinct_id: props.distinct_id,
          currentUserIdentifier: props.currentUserIdentifier,
          created_at: fmtCH(createdMs),
        }));
      }
      continue;
    }

    if (written >= MAX_INSERT) { rl.close(); break outer; }
    try {
      const ev = provider!.transformEvent({ event: rec.event, properties: props });
      ev.profile_id = uid;
      ev.created_at = fmtCH(createdMs);
      ev.imported_at = fmtCH(Date.now());
      batch.push(toRow(ev));
    } catch {
      xformErr++;
      continue;
    }
    if (batch.length >= BATCH) await flush();
  }
  if (!DRY_RUN) {
    await flush();
    await Promise.all(inflight);
  }

  console.log(
    `[DONE] month=${MONTH} total=${total} resolved=${resolved} (byEmail=${byEmail} byUser=${byUser}) ` +
      `anon=${anon} afterCutoff=${afterCutoff} parseErr=${parseErr} xformErr=${xformErr} written=${written} ` +
      `identified_pct=${total ? ((100 * (resolved + afterCutoff)) / total).toFixed(1) : 0}`,
  );
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });

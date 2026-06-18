/**
 * migrate-newton-mixpanel-events
 * ------------------------------
 * Load IDENTIFIED Mixpanel events (newton-school) into OpenPanel's `events` table.
 *
 * Transform = a faithful port of @openpanel/importer's MixpanelProvider.transformEvent
 * (UA -> os/browser/device/model, referrer classification, parsePath -> path/origin,
 * geo, utm -> __query.utm_*, $mp_web_page_view -> screen_view, __source_insert_id + __keys)
 * with three OVERRIDES: profile_id -> resolved newton uid; created_at -> (time - tzShift)
 * IST->UTC; imported_at -> now. We import the REAL parsers (parseUserAgent / parseReferrer)
 * directly — NOT MixpanelProvider — because that pulls @openpanel/db's index (buffers ->
 * @openpanel/queue) which opens a Redis connection at module load. The parsers are loaded
 * LAZILY (only on the real-insert / --xform path) so the pure --dry-run analysis runs
 * without the lru-cache shim. parser-user-agent uses lru-cache@11 (ESM-only, jiti can't
 * construct it) -> alias it to the Map-backed shim:
 *   JITI_ALIAS='{"lru-cache":"<abs>/packages/db/scripts/lru-cache-shim.ts"}'
 *
 * DUP-PREVENTION: created_at < --cutoff (OP oldest event 2026-04-30). Intersection window
 * deferred. IDEMPOTENCY: one --month per run = one CH partition; redo = --drop-partition
 * (safe — pre-cutoff partitions are exclusively ours). Anonymous events (no uid) skipped.
 *
 * Prep + run: see deploy/events-*.yaml.
 */
import { randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream, readFileSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { parseArgs } from 'node:util';
import { createGunzip, createGzip } from 'node:zlib';
import { ClickHouseLogLevel } from '@clickhouse/client';
import { TABLE_NAMES, ch, createClient } from '../src/clickhouse/client';

const { values } = parseArgs({
  options: {
    dir: { type: 'string' },
    month: { type: 'string' },
    identity: { type: 'string' },
    'project-id': { type: 'string' },
    cutoff: { type: 'string', default: '2026-04-30T00:00:00Z' },
    'tz-shift': { type: 'string', default: '19800' },
    batch: { type: 'string', default: '5000' },
    concurrency: { type: 'string', default: '8' },
    control: { type: 'string' },
    reset: { type: 'boolean', default: false }, // ALTER DELETE this month's range before load (clean redo)
    'dry-run': { type: 'boolean', default: false },
    sample: { type: 'string' },
    limit: { type: 'string' },
    'max-insert': { type: 'string' },
    xform: { type: 'boolean', default: false },
    shard: { type: 'string', default: '0/1' }, // "k/N": this pod handles lines where idx%N==k
    resume: { type: 'boolean', default: false }, // resume a wedged month: skip committed rows, reconcile the boundary by __source_insert_id
    'resume-safety': { type: 'string', default: '500000' }, // reconcile-zone half-width (>= concurrency*batch covers any out-of-order frontier hole)
    'insert-timeout': { type: 'string', default: '120000' }, // hard per-insert deadline (ms); aborts a stalled insert instead of hanging
    'emit-anon': { type: 'boolean', default: false }, // FILTER mode: write UNRESOLVED (anon) events as anon rows to --out (no CH insert)
    out: { type: 'string' }, // --emit-anon output path (gzipped JSONL of CH-ready anon rows)
  },
  strict: true,
});

const DROP_EVENT_NAMES = new Set(['$identify', '$create_alias', '$merge']);

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
const XFORM = values.xform ?? false;
const [SHARD_K, SHARD_N] = ((values.shard ?? '0/1').split('/').map(Number)) as [number, number];
const RESUME = values.resume ?? false;
const RESUME_SAFETY = Number.parseInt(values['resume-safety'] ?? '500000', 10);
const INSERT_TIMEOUT_MS = Number.parseInt(values['insert-timeout'] ?? '120000', 10);
const EMIT_ANON = values['emit-anon'] ?? false;
const OUT = values.out;

if (!DIR || !MONTH || !PROJECT_ID || !values.identity) {
  console.error('required: --dir <events dir> --month YYYY-MM --identity <map.json> --project-id <id>');
  process.exit(1);
}
if (Number.isNaN(CUTOFF_MS)) { console.error(`bad --cutoff: ${values.cutoff}`); process.exit(1); }

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const fmtCH = (ms: number): string => new Date(ms).toISOString().replace('T', ' ').replace('Z', '');
type Props = Record<string, any>;
const lc = (s: unknown) => (typeof s === 'string' ? s.trim().toLowerCase() : '');

// ---- live rate control (shared token bucket) -----------------------------
const control = { rowsPerSec: 0, paused: false };
function applyControl() {
  if (!values.control) return;
  try {
    const c = JSON.parse(readFileSync(values.control, 'utf8'));
    if (typeof c.rowsPerSec === 'number') control.rowsPerSec = c.rowsPerSec;
    if (typeof c.paused === 'boolean') control.paused = c.paused;
  } catch { /* keep last good */ }
}
const bucket = {
  tokens: 0,
  last: Date.now(),
  async acquire(n: number) {
    while (control.paused) await sleep(1000);
    const rate = control.rowsPerSec;
    if (!rate || rate <= 0) return;
    const cap = Math.max(rate, n); // burst capacity >= one batch, else acquire(n>rate) loops forever
    for (;;) {
      const now = Date.now();
      this.tokens = Math.min(cap, this.tokens + ((now - this.last) / 1000) * rate);
      this.last = now;
      if (this.tokens >= n) { this.tokens -= n; return; }
      await sleep(Math.min(1000, ((n - this.tokens) / rate) * 1000));
    }
  },
};

// ---- dedicated insert client --------------------------------------------
// The shared `ch` proxy inserts with request_timeout=300s + wait_end_of_query=1 + progress
// headers, so under parts-delay backpressure CH HOLDS the socket and the client never times
// out -> the 15-min wedge that killed the first run. Here each insert gets a HARD AbortController
// deadline (fires regardless of progress headers) and a bounded retry that THROWS on exhaustion,
// so a stuck insert fails the job cleanly (backoffLimit 0 -> Failed, resumable) instead of hanging.
const insertCh = createClient({
  url: process.env.CLICKHOUSE_URL,
  request_timeout: INSERT_TIMEOUT_MS,
  max_open_connections: CONCURRENCY + 2,
  keep_alive: { enabled: true, idle_socket_ttl: 30_000 },
  compression: { request: true },
  log: { level: ClickHouseLogLevel.WARN }, // no per-insert DEBUG dumps
});
// Quiet client for count / reconcile / verify — the shared `ch` DEBUG-logs every query, and the
// reconcile IN() list is multi-MB, so its query text floods the pod log and slows it down.
const queryCh = createClient({
  url: process.env.CLICKHOUSE_URL,
  request_timeout: 120_000,
  clickhouse_settings: { date_time_input_format: 'best_effort' },
  log: { level: ClickHouseLogLevel.WARN },
});
async function q<T>(query: string, settings?: Record<string, unknown>): Promise<T[]> {
  const r = await queryCh.query({ query, format: 'JSONEachRow', clickhouse_settings: settings as any });
  return r.json<T>();
}
async function insertRows(rows: any[]): Promise<void> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 4; attempt++) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), INSERT_TIMEOUT_MS);
    try {
      await insertCh.insert({
        table: TABLE_NAMES.events, values: rows, format: 'JSONEachRow', abort_signal: ac.signal,
        clickhouse_settings: {
          max_insert_block_size: '500000', input_format_parallel_parsing: 1,
          date_time_input_format: 'best_effort', wait_end_of_query: 1,
        },
      });
      clearTimeout(timer);
      return;
    } catch (e) { clearTimeout(timer); lastErr = e; await sleep(500 * 2 ** attempt); }
  }
  throw lastErr;
}

// ---- identity resolution (email / username -> uid) ------------------------
function resolveUid(props: Props, idmap: Map<string, string>): string {
  const email = lc(props.$user_id);
  if (email && email.includes('@')) { const h = idmap.get(email); if (h) return h; }
  const di = props.distinct_id;
  if (typeof di === 'string' && di && !di.startsWith('$device:')) { const h = idmap.get(`u:${di}`); if (h) return h; }
  const cui = props.currentUserIdentifier;
  if (typeof cui === 'string' && cui) { const h = idmap.get(`u:${cui}`); if (h) return h; }
  if (typeof di === 'string' && di.includes('@')) { const h = idmap.get(lc(di)); if (h) return h; }
  return '';
}

// ---- transform helpers (verbatim port from MixpanelProvider) --------------
function isWebEvent(mp_lib: string) {
  return ['web', 'android', 'iphone', 'swift', 'unity', 'react-native'].includes(mp_lib);
}
function isServerEvent(mp_lib: string) { return !isWebEvent(mp_lib); }

function parseServerDeviceInfo(props: Props) {
  return {
    isServer: true,
    os: props.$os || props.os || '',
    osVersion: props.$os_version || props.osVersion || '',
    browser: '', browserVersion: '',
    device: String(props.$os || props.os || '').toLowerCase(),
    brand: props.$brand || props.phoneBrand || '',
    model: props.$model || props.phoneModel || '',
  };
}

function getDeviceType(mp_lib: string, uaInfo: any, props: Props) {
  const lib = (mp_lib || '').toLowerCase();
  const os = String(props.$os || uaInfo.os || '').toLowerCase();
  const browser = String(props.$browser || uaInfo.browser || '').toLowerCase();
  const isTabletOs = os === 'ipados' || os === 'ipad os' || os === 'ipad';
  if (['android', 'iphone', 'react-native', 'swift', 'unity'].includes(lib)) return isTabletOs ? 'tablet' : 'mobile';
  const isMobileSignal =
    os === 'ios' || os === 'android' ||
    browser.includes('mobile safari') || browser.includes('chrome ios') ||
    browser.includes('android mobile') || browser.includes('samsung internet') || browser.includes('mobile');
  if (isMobileSignal) return 'mobile';
  const isTabletSignal = isTabletOs || browser.includes('tablet') ||
    (browser.includes('mobile safari') && (os === 'mac os x' || os === 'macos'));
  if (isTabletSignal) return 'tablet';
  return isServerEvent(mp_lib) ? 'server' : 'desktop';
}

function stripMixpanelProperties(properties: Props, searchParams: Record<string, string>): Props {
  const strip = new Set([
    'time', 'distinct_id', 'current_page_title', 'current_url_path',
    'current_url_protocol', 'current_url_search', 'current_domain',
    ...Object.keys(searchParams),
  ]);
  const parsed: Props = {};
  for (const [key, value] of Object.entries(properties)) {
    if (/^(\$|mp_|utm_)/.test(key) || strip.has(key)) continue;
    if (typeof value === 'string' && (value.startsWith('{') || value.startsWith('['))) {
      try { parsed[key] = JSON.parse(value); } catch { parsed[key] = value; }
    } else parsed[key] = value;
  }
  return parsed;
}

// ---- lazy-loaded real parsers (need the lru-cache shim) -------------------
type Deps = {
  parsePath: (u: string) => any;
  isSameDomain: (a: string, b: string) => boolean;
  toDots: (o: Record<string, unknown>) => Record<string, string>;
  parseReferrer: (u: string | undefined) => { name: string; type: string; url: string };
  getReferrerWithQuery: (q: Record<string, string> | undefined) => { name: string; type: string } | null;
  parseUserAgent: (ua: string, props: Props) => any;
};
async function loadDeps(): Promise<Deps> {
  const [common, ref, ua] = await Promise.all([
    import('@openpanel/common'),
    import('../../common/server/parse-referrer'),
    import('../../common/server/parser-user-agent'),
  ]);
  return {
    parsePath: (common as any).parsePath,
    isSameDomain: (common as any).isSameDomain,
    toDots: (common as any).toDots,
    parseReferrer: (ref as any).parseReferrer,
    getReferrerWithQuery: (ref as any).getReferrerWithQuery,
    parseUserAgent: (ua as any).parseUserAgent,
  };
}

// ---- the full event transform (-> events-table row) -----------------------
function buildRow(D: Deps, eventName: string, props: Props, uid: string, createdMs: number) {
  const fullUrl = props.$current_url;
  let path = '', origin = '', hash = '';
  let query: Record<string, string> = {};
  if (fullUrl) {
    const p = D.parsePath(fullUrl);
    path = p.path || ''; origin = p.origin || ''; hash = p.hash || ''; query = p.query || {};
  }
  const referrerUrl = props.$initial_referrer || props.$referrer || '';
  const referrer = referrerUrl && !D.isSameDomain(referrerUrl, fullUrl) ? D.parseReferrer(referrerUrl) : null;
  const utmReferrer = D.getReferrerWithQuery(query);
  const country = props.$country || props.mp_country_code || '';
  const city = props.$city || '';
  const region = props.$region || '';
  const userAgent = props.osVersion || '';
  const uaInfo = isWebEvent(props.mp_lib) ? D.parseUserAgent(userAgent, props) : parseServerDeviceInfo(props);
  const name = eventName === '$mp_web_page_view' ? 'screen_view' : eventName;

  const properties: Props = stripMixpanelProperties(props, query);
  if (props.$insert_id) properties.__source_insert_id = String(props.$insert_id);
  if (props.$screen_width && props.$screen_height) properties.__screen = `${props.$screen_width}x${props.$screen_height}`;
  if (props.$screen_dpi) properties.__dpi = props.$screen_dpi;
  if (props.$language) properties.__language = props.$language;
  if (props.$timezone) properties.__timezone = props.$timezone;
  if (props.$app_version) properties.__version = props.$app_version;
  if (props.$app_build_number) properties.__buildNumber = props.$app_build_number;
  if (props.$lib_version) properties.__lib_version = props.$lib_version;
  if (hash) properties.__hash = hash;
  if (Object.keys(query).length > 0) properties.__query = query;
  if (props.current_page_title) properties.__title = props.current_page_title;
  if (userAgent) properties.__userAgent = userAgent;

  const flat = D.toDots(properties);
  // utm hack (mirrors transformEvent): top-level utm_source not captured via __query
  if (props.utm_source && !flat['__query.utm_source']) {
    const split = decodeURIComponent(String(props.utm_source)).split('&');
    const q = Object.fromEntries(split.map((i) => i.split('=')));
    for (const [k, v] of Object.entries(q)) {
      if (k && v) flat[`__query.${k}`] = String(v);
      else if (v === undefined && k && String(props.utm_source).startsWith(k)) flat['__query.utm_source'] = String(k);
    }
  }

  return {
    id: randomUUID(),
    name,
    sdk_name: props.mp_lib ? `mixpanel (${props.mp_lib})` : 'mixpanel',
    sdk_version: '1.0.0',
    device_id: props.$device_id ?? '',
    profile_id: uid, // OVERRIDE: resolved newton uid
    project_id: PROJECT_ID!,
    session_id: '',
    path,
    origin,
    referrer: referrer?.url || '',
    referrer_name: utmReferrer?.name || referrer?.name || '',
    referrer_type: referrer?.type || utmReferrer?.type || '',
    duration: 0,
    properties: flat,
    created_at: fmtCH(createdMs), // OVERRIDE: IST->UTC
    country,
    city,
    region,
    longitude: null,
    latitude: null,
    os: uaInfo.os || props.$os || '',
    os_version: uaInfo.osVersion || props.$os_version || '',
    browser: uaInfo.browser || props.$browser || '',
    browser_version: uaInfo.browserVersion || String(props.$browser_version ?? ''),
    device: getDeviceType(props.mp_lib, uaInfo, props),
    brand: uaInfo.brand || '',
    model: uaInfo.model || '',
    imported_at: fmtCH(Date.now()), // OVERRIDE: provenance
  };
}

// ---- main ----------------------------------------------------------------
async function main() {
  const idmap = new Map<string, string>(
    Object.entries(JSON.parse(await readFile(values.identity!, 'utf8')) as Record<string, string>),
  );
  console.log(`[identity] ${idmap.size} keys`);

  const files = (await readdir(DIR!)).filter((f) => f.startsWith(`${MONTH}-01_`) && f.endsWith('.jsonl.gz'));
  if (files.length !== 1) {
    console.error(`expected exactly one chunk for ${MONTH} in ${DIR}, found: ${files.join(', ') || '(none)'}`);
    process.exit(1);
  }
  const file = `${DIR}/${files[0]}`;
  console.log(`[file] ${file}  cutoff=${values.cutoff}  tzShift=${TZ_SHIFT_MS / 1000}s  dryRun=${DRY_RUN}`);

  const D = !DRY_RUN || XFORM ? await loadDeps() : null;

  // This chunk's UTC created_at range = [MONTH-01 IST, nextMonth-01 IST) shifted to UTC,
  // capped at the cutoff. Disjoint per month (partitions DON'T align 1:1 due to the IST->UTC
  // shift), so this range is the clean identifier for integrity + rollback.
  const [yy, mm] = MONTH!.split('-').map(Number) as [number, number];
  const nextMonth = mm === 12 ? `${yy + 1}-01` : `${yy}-${String(mm + 1).padStart(2, '0')}`;
  const rangeStartMs = Date.parse(`${MONTH}-01T00:00:00Z`) - TZ_SHIFT_MS;
  const rangeEndMs = Math.min(Date.parse(`${nextMonth}-01T00:00:00Z`) - TZ_SHIFT_MS, CUTOFF_MS);
  const rangeStart = fmtCH(rangeStartMs);
  const rangeEnd = fmtCH(rangeEndMs);
  const rangeClause =
    `project_id = '${PROJECT_ID}' AND created_at >= '${rangeStart}' AND created_at < '${rangeEnd}' AND imported_at IS NOT NULL`;
  console.log(`[range] created_at [${rangeStart}, ${rangeEnd})  (rollback/integrity scope)`);

  if (!DRY_RUN && values.reset && SHARD_K === 0) { // only one shard resets the shared range
    console.log(`[reset] ALTER TABLE ${TABLE_NAMES.events} DELETE WHERE ${rangeClause}`);
    try {
      await ch.command({
        query: `ALTER TABLE ${TABLE_NAMES.events} DELETE WHERE ${rangeClause}`,
        clickhouse_settings: { mutations_sync: '1' },
      });
    } catch (e) {
      // ClickHouse Cloud may return 341 UNFINISHED (a replica is momentarily inactive) —
      // the mutation still completes asynchronously. The post-load [VERIFY] (ch_count ==
      // written) is the backstop: any residual rows would surface as match=false.
      const msg = (e as Error).message || '';
      if (/UNFINISHED|\b341\b|finish asynchronously/i.test(msg)) {
        console.log('[reset] mutation submitted async (replica inactive); continuing — [VERIFY] will confirm');
      } else throw e;
    }
  }

  // ---- resume: skip already-committed rows; reconcile the boundary by __source_insert_id ----
  // committed rows == a dense prefix of `resolved` (the eligible-index) MINUS the <=CONCURRENCY
  // hung frontier batches. So below (C - safety) is hole-free => skip; the (C-safety, C+safety]
  // zone may contain frontier holes/dups => reconcile by insert_id; above C+safety is all new.
  let resumeC = 0, skipBelow = -1, zoneHi = -1;
  if (RESUME && !DRY_RUN) {
    const r = await q<{ c: string }>(`SELECT count() AS c FROM ${TABLE_NAMES.events} WHERE ${rangeClause}`);
    resumeC = Number(r[0]?.c ?? 0);
    skipBelow = resumeC - RESUME_SAFETY;
    zoneHi = resumeC + RESUME_SAFETY;
    console.log(`[resume] committed=${resumeC} safety=${RESUME_SAFETY} skip<=${skipBelow} reconcileZone=(${skipBelow}, ${zoneHi}]`);
  }

  let total = 0, resolved = 0, byEmail = 0, byUser = 0, anon = 0;
  let afterCutoff = 0, droppedName = 0, parseErr = 0, xformErr = 0, written = 0, samples = 0;
  let skippedCommitted = 0, zonePresent = 0, zoneInserted = 0, zoneNoIdSkip = 0, tailInserted = 0;

  const inflight = new Set<Promise<void>>();
  let batch: any[] = [];
  applyControl();

  async function flush() {
    if (batch.length === 0) return;
    const rows = batch; batch = [];
    applyControl();
    await bucket.acquire(rows.length);
    const p = insertRows(rows)
      .then(() => {
        written += rows.length;
        if (written % (BATCH * 20) < BATCH) {
          console.log(`[insert] written=${written} resolved=${resolved} anon=${anon} rate=${control.rowsPerSec || 'unl'}${control.paused ? ' PAUSED' : ''}`);
        }
      })
      .finally(() => { inflight.delete(p); });
    inflight.add(p);
    if (inflight.size >= CONCURRENCY) await Promise.race(inflight);
  }

  // ---- reconcile-zone: insert only the rows whose __source_insert_id is NOT already in CH ----
  const ZONE_CHUNK = 50_000;
  let zoneBuf: { row: any; sid: string; below: boolean }[] = [];
  const quoteId = (s: string) => `'${s.replace(/'/g, "''")}'`;
  async function reconcileZone() {
    if (zoneBuf.length === 0) return;
    const chunk = zoneBuf; zoneBuf = [];
    const ids = [...new Set(chunk.map((z) => z.sid).filter(Boolean))];
    let present = new Set<string>();
    if (ids.length) {
      const rows = await q<{ sid: string }>(
        `SELECT DISTINCT properties['__source_insert_id'] AS sid FROM ${TABLE_NAMES.events} ` +
          `WHERE ${rangeClause} AND properties['__source_insert_id'] IN (${ids.map(quoteId).join(',')})`,
        { max_query_size: '1000000000' }, // ZONE_CHUNK ids -> multi-MB IN list, far over the 256KB default
      );
      present = new Set(rows.map((r) => r.sid));
    }
    for (const z of chunk) {
      if (z.sid ? present.has(z.sid) : z.below) { // already committed -> skip (no dup)
        if (z.sid) zonePresent++; else zoneNoIdSkip++;
        continue;
      }
      batch.push(z.row); zoneInserted++;
      if (batch.length >= BATCH) await flush();
    }
  }

  if (SHARD_N > 1) console.log(`[shard] ${SHARD_K}/${SHARD_N} (this pod handles lines where idx%${SHARD_N}==${SHARD_K})`);
  // ---- EMIT-ANON (filter mode): write UNRESOLVED events as anon rows to --out (gz), no CH insert ----
  let anonGz: ReturnType<typeof createGzip> | null = null;
  let anonEmitted = 0, anonResolvedSkip = 0, anonNoKey = 0;
  if (EMIT_ANON) {
    if (!OUT) { console.error('--emit-anon requires --out'); process.exit(1); }
    anonGz = createGzip();
    anonGz.pipe(createWriteStream(OUT));
  }
  const rl = createInterface({ input: createReadStream(file).pipe(createGunzip()), crlfDelay: Number.POSITIVE_INFINITY });
  let lineIdx = -1;
  outer: for await (const line of rl) {
    lineIdx++;
    if (SHARD_N > 1 && lineIdx % SHARD_N !== SHARD_K) continue; // not this shard's line (uniform across shards)
    if (!line) continue;
    if (total >= LIMIT) break;
    total++;
    let rec: { event?: string; properties?: Props };
    try { rec = JSON.parse(line); } catch { parseErr++; continue; }
    const props = rec.properties;
    if (!props || !rec.event) { parseErr++; continue; }
    if (DROP_EVENT_NAMES.has(rec.event)) { droppedName++; continue; }

    const uid = resolveUid(props, idmap);
    if (EMIT_ANON) {
      if (uid) { anonResolvedSkip++; continue; } // identified -> already loaded in the main pass
      const ta = props.time;
      const cms = typeof ta === 'number' ? ta * 1000 - TZ_SHIFT_MS : Number.NaN;
      if (!Number.isNaN(cms) && cms >= CUTOFF_MS) { afterCutoff++; continue; } // pre-cutoff only
      const di = (typeof props.distinct_id === 'string' && props.distinct_id) ? props.distinct_id
        : (typeof props.$device_id === 'string' && props.$device_id) ? props.$device_id : '';
      if (!di) { anonNoKey++; continue; }
      const anonId = `mp:distinct_id:${di}`;
      let arow: any;
      try { arow = buildRow(D!, rec.event, props, anonId, cms); } catch { xformErr++; continue; }
      arow.device_id = anonId;                       // anon convention: profile_id == device_id
      arow.properties.__mp_device_id = props.$device_id ?? ''; // preserve real device id
      if (!anonGz!.write(`${JSON.stringify(arow)}\n`)) await once(anonGz!, 'drain');
      anonEmitted++;
      continue;
    }
    if (!uid) { anon++; continue; }

    const t = props.time;
    const createdMs = typeof t === 'number' ? t * 1000 - TZ_SHIFT_MS : Number.NaN;
    if (!Number.isNaN(createdMs) && createdMs >= CUTOFF_MS) { afterCutoff++; continue; }

    resolved++;
    if (lc(props.$user_id).includes('@') && idmap.get(lc(props.$user_id)) === uid) byEmail++; else byUser++;

    if (DRY_RUN) {
      if (samples < SAMPLE) {
        samples++;
        if (XFORM && D) {
          try { console.log('[sample]', JSON.stringify(buildRow(D, rec.event, props, uid, createdMs))); }
          catch (e) { console.log('[sample] transform error:', (e as Error).message); }
        } else {
          console.log('[sample]', JSON.stringify({ event: rec.event, uid, email: lc(props.$user_id), distinct_id: props.distinct_id, created_at: fmtCH(createdMs) }));
        }
      }
      continue;
    }

    if (written >= MAX_INSERT) { rl.close(); break outer; }
    // resume: `resolved` is the eligible-index. Below the zone = already committed (skip);
    // inside the zone = reconcile by insert_id; above = definitely new (insert directly).
    if (RESUME && resolved <= skipBelow) { skippedCommitted++; continue; }
    let row: any;
    try { row = buildRow(D!, rec.event, props, uid, createdMs); }
    catch { xformErr++; continue; }
    if (RESUME && resolved <= zoneHi) {
      zoneBuf.push({ row, sid: row.properties.__source_insert_id ?? '', below: resolved <= resumeC });
      if (zoneBuf.length >= ZONE_CHUNK) await reconcileZone();
      continue;
    }
    batch.push(row); tailInserted++;
    if (batch.length >= BATCH) await flush();
  }
  if (EMIT_ANON) {
    anonGz!.end();
    await once(anonGz!, 'finish');
    console.log(`[DONE emit-anon] month=${MONTH} total=${total} emitted=${anonEmitted} resolvedSkip=${anonResolvedSkip} noKey=${anonNoKey} afterCutoff=${afterCutoff} droppedName=${droppedName} xformErr=${xformErr}`);
    return;
  }
  if (!DRY_RUN) { if (RESUME) await reconcileZone(); await flush(); await Promise.all(inflight); }

  // Integrity: CH rows in this chunk's range must equal what we wrote. Disjoint per month.
  // Skipped when sharded (each shard wrote only 1/N) — the orchestrator verifies the combined
  // month (CH count(range) == sum of shards' written) after all shards finish.
  if (!DRY_RUN && SHARD_N <= 1) {
    const rows = await q<{ c: string }>(
      `SELECT count() AS c FROM ${TABLE_NAMES.events} WHERE ${rangeClause}`,
    );
    const chCount = Number(rows[0]?.c ?? 0);
    const expected = resolved - xformErr; // every eligible source row present exactly once
    console.log(`[VERIFY] month=${MONTH} ch_count=${chCount} expected=${expected} written=${written} match=${chCount === expected}`);
    if (RESUME) console.log(`[RESUME-STAT] committed_before=${resumeC} skipped=${skippedCommitted} zonePresent=${zonePresent} zoneNoIdSkip=${zoneNoIdSkip} zoneInserted=${zoneInserted} tailInserted=${tailInserted} new=${written}`);
    console.log(`[ROLLBACK] ALTER TABLE ${TABLE_NAMES.events} DELETE WHERE ${rangeClause}`);
  }

  console.log(
    `[DONE] month=${MONTH} total=${total} resolved=${resolved} (byEmail=${byEmail} byUser=${byUser}) ` +
      `anon=${anon} afterCutoff=${afterCutoff} droppedName=${droppedName} parseErr=${parseErr} xformErr=${xformErr} written=${written} ` +
      `identified_pct=${total ? ((100 * (resolved + afterCutoff)) / total).toFixed(1) : 0}`,
  );
}

main().then(() => process.exit(0)).catch((err) => { console.error(err); process.exit(1); });

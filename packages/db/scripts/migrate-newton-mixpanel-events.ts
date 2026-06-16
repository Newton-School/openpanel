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
import { createReadStream, readFileSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { parseArgs } from 'node:util';
import { createGunzip } from 'node:zlib';
import { TABLE_NAMES, ch, chQuery } from '../src/clickhouse/client';

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

  if (!DRY_RUN && values.reset) {
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

  let total = 0, resolved = 0, byEmail = 0, byUser = 0, anon = 0;
  let afterCutoff = 0, droppedName = 0, parseErr = 0, xformErr = 0, written = 0, samples = 0;

  const inflight = new Set<Promise<void>>();
  let batch: any[] = [];
  applyControl();

  async function flush() {
    if (batch.length === 0) return;
    const rows = batch; batch = [];
    applyControl();
    await bucket.acquire(rows.length);
    const p = ch
      .insert({ table: TABLE_NAMES.events, values: rows, format: 'JSONEachRow' })
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

  const rl = createInterface({ input: createReadStream(file).pipe(createGunzip()), crlfDelay: Number.POSITIVE_INFINITY });
  outer: for await (const line of rl) {
    if (!line) continue;
    if (total >= LIMIT) break;
    total++;
    let rec: { event?: string; properties?: Props };
    try { rec = JSON.parse(line); } catch { parseErr++; continue; }
    const props = rec.properties;
    if (!props || !rec.event) { parseErr++; continue; }
    if (DROP_EVENT_NAMES.has(rec.event)) { droppedName++; continue; }

    const uid = resolveUid(props, idmap);
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
    try { batch.push(buildRow(D!, rec.event, props, uid, createdMs)); }
    catch { xformErr++; continue; }
    if (batch.length >= BATCH) await flush();
  }
  if (!DRY_RUN) { await flush(); await Promise.all(inflight); }

  // Integrity: CH rows in this chunk's range must equal what we wrote. Disjoint per month.
  if (!DRY_RUN) {
    const rows = await chQuery<{ c: string }>(
      `SELECT count() AS c FROM ${TABLE_NAMES.events} WHERE ${rangeClause}`,
    );
    const chCount = Number(rows[0]?.c ?? 0);
    console.log(`[VERIFY] month=${MONTH} ch_count=${chCount} written=${written} match=${chCount === written}`);
    console.log(`[ROLLBACK] ALTER TABLE ${TABLE_NAMES.events} DELETE WHERE ${rangeClause}`);
  }

  console.log(
    `[DONE] month=${MONTH} total=${total} resolved=${resolved} (byEmail=${byEmail} byUser=${byUser}) ` +
      `anon=${anon} afterCutoff=${afterCutoff} droppedName=${droppedName} parseErr=${parseErr} xformErr=${xformErr} written=${written} ` +
      `identified_pct=${total ? ((100 * (resolved + afterCutoff)) / total).toFixed(1) : 0}`,
  );
}

main().then(() => process.exit(0)).catch((err) => { console.error(err); process.exit(1); });

/**
 * Phase B of the ANON pass: dedup + insert.
 *
 * Reads the per-month anon files produced by `migrate-newton-mixpanel-events.ts --emit-anon`
 * (CH-ready rows: profile_id = device_id = mp:distinct_id:<distinct_id>), deduplicates them
 * GLOBALLY (across all months — so cross-month duplicates AND Mixpanel's ~3.5x raw-export
 * byte-duplication both collapse), and inserts the unique rows into the live events table.
 *
 * Dedup key = properties.__source_insert_id (Mixpanel $insert_id — unique per real event,
 * 100% present in this data). The few rows without one fall back to a content hash of the
 * stable fields (everything the emitter derives deterministically from the source).
 *
 * This is the single controlled writer for the anon set. Inserting into `events` (not a
 * REPLACE PARTITION) means the 6 materialized views fire on these blocks and self-update —
 * no MV rebuild needed. The 1.23B identified rows + the live post-cutoff rows are untouched:
 * we only ADD anon rows (profile_id == device_id), which the profile/cohort MVs already
 * exclude by their `profile_id != device_id` filter.
 *
 *   pnpm exec jiti scripts/insert-anon-deduped.ts --dir /data/anon            # real
 *   pnpm exec jiti scripts/insert-anon-deduped.ts --dir /data/anon --dry-run  # count only
 */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { parseArgs } from 'node:util';
import { createGunzip } from 'node:zlib';
import { ClickHouseLogLevel } from '@clickhouse/client';
import { TABLE_NAMES, createClient } from '../src/clickhouse/client';

const { values } = parseArgs({
  options: {
    dir: { type: 'string' },
    batch: { type: 'string', default: '100000' },
    concurrency: { type: 'string', default: '3' },
    'insert-timeout': { type: 'string', default: '120000' },
    'project-id': { type: 'string', default: 'platform' },
    'dry-run': { type: 'boolean', default: false },
    limit: { type: 'string' }, // optional cap for smoke tests
  },
});
const DIR = values.dir;
const BATCH = Number.parseInt(values.batch ?? '100000', 10);
const CONCURRENCY = Number.parseInt(values.concurrency ?? '3', 10);
const INSERT_TIMEOUT_MS = Number.parseInt(values['insert-timeout'] ?? '120000', 10);
const PROJECT_ID = values['project-id'] ?? 'platform';
const DRY_RUN = values['dry-run'] ?? false;
const LIMIT = values.limit ? Number.parseInt(values.limit, 10) : Number.POSITIVE_INFINITY;
if (!DIR) { console.error('--dir is required'); process.exit(1); }

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const insertCh = createClient({
  url: process.env.CLICKHOUSE_URL,
  request_timeout: INSERT_TIMEOUT_MS,
  max_open_connections: CONCURRENCY + 2,
  keep_alive: { enabled: true, idle_socket_ttl: 30_000 },
  compression: { request: true },
  log: { level: ClickHouseLogLevel.WARN },
});

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

// Stable dedup key. __source_insert_id is unique per real Mixpanel event and present on
// ~100% of rows; the rare row without one keys on a hash of the deterministic content.
function dedupKey(row: any): string {
  const sid = row?.properties?.__source_insert_id;
  if (typeof sid === 'string' && sid) return `i:${sid}`;
  const h = createHash('sha1');
  h.update(`${row.name}|${row.profile_id}|${row.created_at}|${JSON.stringify(row.properties ?? {})}`);
  return `h:${h.digest('base64')}`;
}

async function main() {
  const files = (await readdir(DIR!)).filter((f) => f.endsWith('.jsonl.gz')).sort();
  console.log(`[anon-insert] dir=${DIR} files=${files.length} dryRun=${DRY_RUN} project=${PROJECT_ID}`);

  const seen = new Set<string>();
  let total = 0, dup = 0, unique = 0, written = 0, parseErr = 0, wrongProject = 0;
  let batch: any[] = [];
  const inflight = new Set<Promise<void>>();

  async function flush() {
    if (batch.length === 0) return;
    const rows = batch; batch = [];
    if (DRY_RUN) { written += rows.length; return; }
    const p = insertRows(rows)
      .then(() => {
        written += rows.length;
        if (written % (BATCH * 10) < BATCH) console.log(`[insert] written=${written} unique=${unique} dup=${dup} total=${total}`);
      })
      .finally(() => { inflight.delete(p); });
    inflight.add(p);
    if (inflight.size >= CONCURRENCY) await Promise.race(inflight);
  }

  for (const file of files) {
    const rl = createInterface({ input: createReadStream(`${DIR}/${file}`).pipe(createGunzip()), crlfDelay: Number.POSITIVE_INFINITY });
    let fileRows = 0;
    for await (const line of rl) {
      if (!line) continue;
      if (total >= LIMIT) break;
      total++; fileRows++;
      let row: any;
      try { row = JSON.parse(line); } catch { parseErr++; continue; }
      if (row.project_id !== PROJECT_ID) { wrongProject++; continue; } // guard: never touch another project
      const k = dedupKey(row);
      if (seen.has(k)) { dup++; continue; }
      seen.add(k);
      unique++;
      batch.push(row);
      if (batch.length >= BATCH) await flush();
    }
    console.log(`[file] ${file} rows=${fileRows} runningUnique=${unique} runningDup=${dup}`);
    if (total >= LIMIT) break;
  }
  await flush();
  await Promise.all(inflight);

  console.log(`[DONE anon-insert] total=${total} unique=${unique} dup=${dup} written=${written} ` +
    `parseErr=${parseErr} wrongProject=${wrongProject} dedupRatio=${total ? (total / Math.max(unique, 1)).toFixed(2) : 0}`);
}

main().then(() => process.exit(0)).catch((err) => { console.error(err); process.exit(1); });

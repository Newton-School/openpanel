import { TABLE_NAMES } from '../src/clickhouse/client';
import {
  chMigrationClient,
  runClickhouseMigrationCommands,
} from '../src/clickhouse/migration';
import { getIsCluster } from './helpers';

/**
 * Backfill the resolved cohort summary MVs (migration 20) with full history.
 *
 *   - event_profile_summary_mv
 *   - event_property_profile_summary_mv
 *
 * Both were created with `populate: false`, so they only index events inserted
 * AFTER their CREATE ran. This feeds them everything before that.
 *
 * DELIBERATELY NOT A NUMBERED MIGRATION: migrate.ts only auto-runs files whose
 * name starts with a number, so this never executes inside the init container
 * (where an eviction mid-run would force a full re-run). Run it supervised:
 *
 *   pnpm tsx packages/db/code-migrations/backfill-resolved-cohort-mvs.ts [flags]
 *
 * RESTART SAFETY -------------------------------------------------------------
 * AggregatingMergeTree is NOT idempotent under re-insert (countState rows merge
 * additively → re-running a range double-counts). The safe unit of retry is the
 * MONTH, because batches are aligned to the tables' toYYYYMM partitions:
 * if a month fails or is interrupted midway, re-run JUST that month with
 * --replace, which drops the month's partition on the target first.
 *
 * IMPORTANT: pass --until=<CREATE time of the MVs, UTC 'YYYY-MM-DD hh:mm:ss'>.
 * Events inserted after CREATE are already indexed by the live MV trigger;
 * backfilling past that point double-counts the overlap. Find it with:
 *   SELECT metadata_modification_time FROM system.tables WHERE name = 'event_profile_summary_mv'
 *
 * Flags:
 *   --dry              Print per-month plan + first batch SQL; execute nothing.
 *   --from=YYYYMM      First month to backfill (default: month of min(created_at)).
 *   --to=YYYYMM        Last month to backfill (default: current month).
 *   --until=DATETIME   Upper bound on created_at (REQUIRED unless --dry; see above).
 *   --batch-days=N     Days of data per INSERT within a month (default 2).
 *   --replace          DROP PARTITION on the target before each month (retry mode).
 *   --only=summary|property   Backfill just one of the two tables.
 */

const DEFAULT_BATCH_DAYS = 2;

// Spill the per-batch GROUP BY to disk instead of OOMing on the ARRAY JOIN
// fan-out; harmless for the narrow summary inserts.
const INSERT_SETTINGS =
  'SETTINGS max_bytes_before_external_group_by = 4294967296';

type Batch = { label: string; sql: string };

function getArg(name: string): string | undefined {
  const prefix = `--${name}=`;
  const arg = process.argv.find((a) => a.startsWith(prefix));
  return arg?.slice(prefix.length);
}

function resolveTargetTable(baseName: string, isClustered: boolean): string {
  return isClustered ? `${baseName}_replicated` : baseName;
}

function monthStart(yyyymm: number): string {
  const y = Math.floor(yyyymm / 100);
  const m = yyyymm % 100;
  return `${y}-${String(m).padStart(2, '0')}-01 00:00:00`;
}

function nextMonth(yyyymm: number): number {
  const y = Math.floor(yyyymm / 100);
  const m = yyyymm % 100;
  return m === 12 ? (y + 1) * 100 + 1 : yyyymm + 1;
}

function summarySelect(startStr: string, endStr: string): string {
  return `SELECT
  project_id,
  profile_id,
  name,
  toStartOfDay(created_at) AS event_date,
  countState() AS event_count,
  minState(created_at) AS first_event_time,
  maxState(created_at) AS last_event_time,
  sumState(duration) AS total_duration
FROM events
WHERE created_at >= toDateTime('${startStr}')
  AND created_at <  toDateTime('${endStr}')
GROUP BY project_id, profile_id, name, event_date`;
}

function propertySelect(startStr: string, endStr: string): string {
  return `SELECT
  project_id,
  profile_id,
  name,
  property_key,
  property_value,
  toStartOfDay(created_at) AS event_date,
  countState() AS event_count,
  minState(created_at) AS first_event_time,
  maxState(created_at) AS last_event_time
FROM events
ARRAY JOIN mapKeys(properties) AS property_key, mapValues(properties) AS property_value
WHERE created_at >= toDateTime('${startStr}')
  AND created_at <  toDateTime('${endStr}')
  AND property_key != ''
  AND property_value != ''
GROUP BY project_id, profile_id, name, property_key, property_value, event_date`;
}

function generateMonthBatches(
  month: number,
  until: string,
  batchDays: number,
  targetTable: string,
  select: (start: string, end: string) => string,
): Batch[] {
  const batches: Batch[] = [];
  const start = new Date(`${monthStart(month).replace(' ', 'T')}Z`);
  const monthEnd = new Date(`${monthStart(nextMonth(month)).replace(' ', 'T')}Z`);
  const untilDate = new Date(`${until.replace(' ', 'T')}Z`);
  const end = monthEnd < untilDate ? monthEnd : untilDate;

  let cursor = new Date(start);
  while (cursor < end) {
    const next = new Date(cursor);
    next.setUTCDate(next.getUTCDate() + batchDays);
    const batchEnd = next > end ? end : next;

    const startStr = cursor.toISOString().slice(0, 19).replace('T', ' ');
    const endStr = batchEnd.toISOString().slice(0, 19).replace('T', ' ');

    batches.push({
      label: `${startStr} → ${endStr}`,
      sql: `INSERT INTO ${targetTable}\n${select(startStr, endStr)}\n${INSERT_SETTINGS}`,
    });
    cursor = batchEnd;
  }

  return batches;
}

async function getMinMonth(): Promise<number> {
  const result = await chMigrationClient.query({
    query: 'SELECT toYYYYMM(min(created_at)) AS m FROM events',
    format: 'JSONEachRow',
  });
  const rows = await result.json<{ m: string }>();
  return Number(rows[0]?.m ?? 0);
}

export async function up() {
  const isClustered = getIsCluster();
  const isDryRun = process.argv.includes('--dry');
  const replaceMode = process.argv.includes('--replace');
  const only = getArg('only');
  const batchDays = Number.parseInt(
    getArg('batch-days') ?? String(DEFAULT_BATCH_DAYS),
    10,
  );

  const now = new Date();
  const currentMonth = now.getUTCFullYear() * 100 + (now.getUTCMonth() + 1);
  const fromMonth = Number.parseInt(
    getArg('from') ?? String(await getMinMonth()),
    10,
  );
  const toMonth = Number.parseInt(getArg('to') ?? String(currentMonth), 10);
  const until = getArg('until');

  if (!until && !isDryRun) {
    console.error(
      '❌ --until=<MV CREATE time, UTC> is required (see header comment) — without it the window indexed by the live MV trigger double-counts.',
    );
    process.exit(1);
  }
  const untilStr =
    until ?? now.toISOString().slice(0, 19).replace('T', ' ');

  const targets: Array<{
    label: string;
    table: string;
    select: (s: string, e: string) => string;
  }> = [];
  if (only !== 'property') {
    targets.push({
      label: 'event_profile_summary_mv',
      table: resolveTargetTable(TABLE_NAMES.event_profile_summary_mv, isClustered),
      select: summarySelect,
    });
  }
  if (only !== 'summary') {
    targets.push({
      label: 'event_property_profile_summary_mv',
      table: resolveTargetTable(
        TABLE_NAMES.event_property_profile_summary_mv,
        isClustered,
      ),
      select: propertySelect,
    });
  }

  const months: number[] = [];
  for (let m = fromMonth; m <= toMonth; m = nextMonth(m)) {
    months.push(m);
  }

  console.log('');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('📦 Resolved cohort MV backfill');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`   Months:      ${fromMonth} → ${toMonth} (${months.length})`);
  console.log(`   Until:       ${untilStr}`);
  console.log(`   Batch size:  ${batchDays} day${batchDays === 1 ? '' : 's'}`);
  console.log(`   Replace:     ${replaceMode}`);
  console.log(`   Targets:     ${targets.map((t) => t.label).join(', ')}`);
  console.log(`   Mode:        ${isDryRun ? 'DRY RUN' : 'EXECUTE'}`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  if (isDryRun) {
    for (const target of targets) {
      const sample = generateMonthBatches(
        months[0]!,
        untilStr,
        batchDays,
        target.table,
        target.select,
      );
      console.log('');
      console.log(`── Sample batch (${target.label}, ${sample.length} batches for ${months[0]}) ──`);
      console.log(sample[0]?.sql);
    }
    return;
  }

  const startedAt = Date.now();
  for (const target of targets) {
    console.log('');
    console.log(`🚀 ${target.label}`);
    for (const month of months) {
      const batches = generateMonthBatches(
        month,
        untilStr,
        batchDays,
        target.table,
        target.select,
      );
      if (batches.length === 0) {
        continue;
      }

      if (replaceMode) {
        await runClickhouseMigrationCommands([
          `ALTER TABLE ${target.table} DROP PARTITION '${month}'`,
        ]);
      }

      const t0 = Date.now();
      for (const batch of batches) {
        await runClickhouseMigrationCommands([batch.sql]);
      }
      const monthSec = Math.round((Date.now() - t0) / 1000);
      const elapsedSec = Math.round((Date.now() - startedAt) / 1000);
      console.log(
        `   ✅ ${month} done in ${monthSec}s (${batches.length} batches, elapsed=${elapsedSec}s)`,
      );
    }
  }

  console.log('');
  console.log('✅ Backfill complete.');
}

export async function down() {
  console.log('⚠️  No down migration — re-run a month with --replace to redo it,');
  console.log('   or DROP + recreate the tables via migration 20 down/up.');
}

// Allow direct execution: pnpm tsx packages/db/code-migrations/backfill-resolved-cohort-mvs.ts
if (import.meta.url === `file://${process.argv[1]}`) {
  up()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}

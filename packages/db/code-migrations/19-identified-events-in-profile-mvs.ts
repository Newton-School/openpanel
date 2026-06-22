import fs from 'node:fs';
import path from 'node:path';
import { TABLE_NAMES } from '../src/clickhouse/client';
import { runClickhouseMigrationCommands } from '../src/clickhouse/migration';
import { getIsCluster } from './helpers';

/**
 * Include identified events in the cohort / retention MVs (Newton fork).
 *
 * THE BUG -------------------------------------------------------------------
 * profile_event_summary_mv, profile_event_property_summary_mv and
 * cohort_events_mv use `WHERE profile_id != device_id` to mean "identified
 * user" — anonymous events default `profile_id = device_id` at ingestion
 * (track.controller.ts: `profileId = payload.profileId ?? context.deviceId`).
 *
 * PR newton-web#8100 ("pin __deviceId to user uid") then made *identified*
 * events also carry `device_id = profile_id` (= uid). They now fail
 * `profile_id != device_id` and are silently dropped — so behavioural cohorts
 * and the retention report lost ~97% of identified-user events the day #8100
 * shipped. (Top-level counts / funnels / DAU are unaffected; they read raw
 * events / events_resolved / unfiltered MVs.)
 *
 * THE FIX -------------------------------------------------------------------
 * Recognise identified users by their profile flag instead of inferring it
 * from device_id. The filter becomes:
 *
 *   profile_id != device_id
 *   OR dictGetOrDefault('openpanel.profiles_is_external', 'is_external',
 *                       (project_id, profile_id), toUInt8(0)) = 1
 *
 * The `profiles_is_external` dictionary is created by the `default` user in the
 * companion 19-...admin.sql (Cloud requires `default` for CLICKHOUSE-source
 * dicts) — RUN THAT FIRST.
 *
 * We `ALTER TABLE ... MODIFY QUERY` (not DROP + CREATE) so the existing MV rows
 * stay live and cohorts/retention have no downtime; only the trigger SELECT
 * changes. The historical rows the old filter missed are then added by the
 * delta backfill below: the events where `profile_id = device_id AND identified`
 * — disjoint from what's already in the MV (`profile_id != device_id`), so no
 * double counting.
 *
 * NOTE — the sort keys are intentionally left unchanged: these MVs are shared
 * with other access paths and reordering could regress them. A cohort query
 * therefore still scans the (now larger) project slice; measured impact ~2-2.8x
 * on a sub-second query — acceptable for cohort-save / report-load paths.
 *
 * Flags:
 *   --dry            Write the .sql artifact and print the plan; execute nothing.
 *   --days=N         Delta-backfill window in days (default 90). Older history
 *                    can be filled by re-running with a larger --days.
 *   --batch-hours=N  Hours of data per backfill INSERT (default 1).
 *   --no-backfill    Apply the MODIFY QUERY only; skip the historical backfill.
 */

const DB = 'openpanel';
const DEFAULT_DAYS = 90;
const DEFAULT_BATCH_HOURS = 1;

const isClustered = getIsCluster();
const isDry = process.argv.includes('--dry');

// Whichever side the original MVs read from (the helper replaces {events}).
const eventsTable = isClustered ? 'events_replicated' : 'events';

// The new "identified user" predicate shared by all three MVs.
const IDENTIFIED = `(profile_id != device_id OR dictGetOrDefault('${DB}.profiles_is_external', 'is_external', (project_id, profile_id), toUInt8(0)) = 1)`;
// The rows the OLD filter missed (disjoint from profile_id != device_id).
const DELTA = `profile_id = device_id AND dictGetOrDefault('${DB}.profiles_is_external', 'is_external', (project_id, profile_id), toUInt8(0)) = 1`;

// Column projections kept byte-for-byte identical to the original MV SELECTs
// (migrations 3, 13, 14) — only the WHERE differs.
const SELECTS: Record<string, { select: (where: string) => string }> = {
  [TABLE_NAMES.cohort_events_mv]: {
    select: (where) => `SELECT
  project_id,
  name,
  toDate(created_at) AS created_at,
  profile_id,
  COUNT() AS event_count
FROM ${eventsTable}
WHERE ${where}
GROUP BY project_id, name, created_at, profile_id`,
  },
  [TABLE_NAMES.profile_event_summary_mv]: {
    select: (where) => `SELECT
  project_id,
  profile_id,
  name,
  toStartOfDay(created_at) AS event_date,
  countState() AS event_count,
  minState(created_at) AS first_event_time,
  maxState(created_at) AS last_event_time,
  sumState(duration) AS total_duration
FROM ${eventsTable}
WHERE ${where}
GROUP BY project_id, profile_id, name, event_date`,
  },
  [TABLE_NAMES.profile_event_property_summary_mv]: {
    select: (where) => `SELECT
  project_id,
  profile_id,
  name,
  property_key,
  property_value,
  toStartOfDay(created_at) AS event_date,
  countState() AS event_count,
  minState(created_at) AS first_event_time,
  maxState(created_at) AS last_event_time
FROM ${eventsTable}
ARRAY JOIN mapKeys(properties) AS property_key, mapValues(properties) AS property_value
WHERE ${where}
GROUP BY project_id, profile_id, name, property_key, property_value, event_date`,
  },
};

// The property MV additionally requires non-empty key/value.
function whereFor(mv: string, base: string): string {
  if (mv === TABLE_NAMES.profile_event_property_summary_mv) {
    return `${base}\n  AND property_key != ''\n  AND property_value != ''`;
  }
  return base;
}

function modifyQuerySql(mv: string): string {
  // In clustered mode the writer is the *_replicated MV; non-clustered it's the
  // MV object itself. ON CLUSTER fans the DDL to every replica.
  const target = isClustered ? `${mv}_replicated` : mv;
  const onCluster = isClustered ? ` ON CLUSTER '{cluster}'` : '';
  const select = SELECTS[mv]!.select(whereFor(mv, IDENTIFIED));
  return `ALTER TABLE ${DB}.${target}${onCluster} MODIFY QUERY\n${select}`;
}

function fmt(d: Date): string {
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

function getArg(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((a) => a.startsWith(prefix))?.slice(prefix.length);
}

function backfillBatches(mv: string, start: Date, end: Date, batchHours: number) {
  const target = isClustered ? `${mv}_replicated` : mv;
  const batches: { from: string; to: string; sql: string }[] = [];
  let cursor = new Date(start);
  while (cursor < end) {
    const next = new Date(cursor);
    next.setUTCHours(next.getUTCHours() + batchHours);
    const batchEnd = next > end ? end : next;
    const where = whereFor(
      mv,
      `${DELTA}\n  AND created_at >= toDateTime('${fmt(cursor)}')\n  AND created_at <  toDateTime('${fmt(batchEnd)}')`,
    );
    batches.push({
      from: fmt(cursor),
      to: fmt(batchEnd),
      sql: `INSERT INTO ${DB}.${target}\n${SELECTS[mv]!.select(where)}`,
    });
    cursor = batchEnd;
  }
  return batches;
}

export async function up() {
  const modifyQueries = Object.keys(SELECTS).map(modifyQuerySql);

  // Persist the schema-change SQL alongside the migration (same convention as 18).
  fs.writeFileSync(
    path.join(import.meta.filename.replace('.ts', '.sql')),
    modifyQueries.map((s) => s.trim().concat(';')).join('\n\n---\n\n'),
  );

  if (isDry) {
    console.log('🔍 DRY RUN — MODIFY QUERY statements:');
    modifyQueries.forEach((s) => console.log(`\n${s}\n`));
  } else {
    console.log('⚡️ Applying MODIFY QUERY to the 3 MVs (no data dropped)…');
    await runClickhouseMigrationCommands(modifyQueries);
  }

  if (process.argv.includes('--no-backfill')) {
    console.log('⏭  --no-backfill: skipping historical delta backfill.');
    return;
  }

  const days = Number.parseInt(getArg('days') ?? String(DEFAULT_DAYS), 10);
  const batchHours = Number.parseInt(
    getArg('batch-hours') ?? String(DEFAULT_BATCH_HOURS),
    10,
  );
  const end = new Date();
  end.setUTCMinutes(0, 0, 0);
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - days);

  console.log(
    `📦 Delta backfill (profile_id = device_id AND identified): ${fmt(start)} → ${fmt(end)} (${days}d, ${batchHours}h batches)`,
  );

  for (const mv of Object.keys(SELECTS)) {
    const batches = backfillBatches(mv, start, end, batchHours);
    if (isDry) {
      console.log(`\n── ${mv}: ${batches.length} batches. Sample ──\n${batches[0]?.sql}`);
      continue;
    }
    console.log(`\n🚀 ${mv}: ${batches.length} batches`);
    const startedAt = Date.now();
    let done = 0;
    for (const b of batches) {
      await runClickhouseMigrationCommands([b.sql]);
      done++;
      const every = Math.max(1, Math.ceil(batches.length / 10));
      if (done % every === 0 || done === batches.length) {
        console.log(
          `   [${Math.round((done / batches.length) * 100)}%] ${done}/${batches.length}  elapsed=${Math.round((Date.now() - startedAt) / 1000)}s  (…${b.to})`,
        );
      }
    }
  }

  console.log('✅ MV filter updated + delta backfill complete.');
}

export async function down() {
  // Revert the trigger SELECTs to the original `profile_id != device_id` filter.
  // (Existing rows — including backfilled identified ones — are left in place;
  // they simply stop being added going forward.)
  const revert = Object.keys(SELECTS).map((mv) => {
    const target = isClustered ? `${mv}_replicated` : mv;
    const onCluster = isClustered ? ` ON CLUSTER '{cluster}'` : '';
    const select = SELECTS[mv]!.select(whereFor(mv, 'profile_id != device_id'));
    return `ALTER TABLE ${DB}.${target}${onCluster} MODIFY QUERY\n${select}`;
  });
  await runClickhouseMigrationCommands(revert);
}

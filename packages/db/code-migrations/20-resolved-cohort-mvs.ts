import fs from 'node:fs';
import path from 'node:path';
import { TABLE_NAMES } from '../src/clickhouse/client';
import {
  createMaterializedView,
  dropTable,
  getExistingTables,
  runClickhouseMigrationCommands,
} from '../src/clickhouse/migration';
import { getIsCluster } from './helpers';

/**
 * Event-keyed, identity-unfiltered cohort summary MVs (Newton fork).
 *
 * THE BUG -------------------------------------------------------------------
 * Event-based cohort membership is computed from profile_event_summary_mv /
 * profile_event_property_summary_mv, which filter at INSERT time to
 * "identified" rows:
 *
 *   (profile_id != device_id) OR profiles_is_external = 1
 *
 * Two structural problems (verified on prod, ~15% membership undercount on
 * `experiment_started` vs the events explorer):
 *
 *  1. The MV judges identity ONCE, per event row, at insert. An event fired
 *     while anonymous is dropped and NEVER re-admitted — a later identify()
 *     flips the dictionary but old rows are gone. The 30-min cohort refresh
 *     faithfully re-reads a source that is permanently missing those rows.
 *  2. The identity signal itself is corrupted: newton-web sends
 *     device_id == profile_id == uid for logged-in users and never calls
 *     identify(), so real identified users fail both arms of the filter
 *     (e.g. uid FND1NU1J3O) and are swept out with the anon traffic.
 *
 * Meanwhile the events explorer / funnels read events_resolved (no identity
 * gate, device_alias folding) — hence "cohort members < users who fired the
 * event" (Mihir, 2026-07-02).
 *
 * THE FIX -------------------------------------------------------------------
 * New summary tables with NO identity filter; all interpretation moves to
 * read time, where cohort.service folds raw ids through the device_alias
 * dictionary (identical semantics to events_resolved). The raw profile_id
 * key is immutable at insert, so nothing can go stale: a late identify()
 * heals retroactively at the next 30-min refresh.
 *
 * While we're rebuilding anyway, the sort key is reshaped for the ONLY
 * consumer (cohort.service — it filters project/name/property/date and
 * groups by profile, never filters by profile):
 *
 *   old: (project_id, profile_id, name, property_key, event_date)
 *   new: (project_id, name, [property_key, property_value,] event_date, profile_id)
 *
 * With profile_id second the old key couldn't prune anything — a cohort
 * criterion scanned the whole project slice (measured: 47.9M rows read for
 * ~40K matches). The new key prunes to the criterion's own slice: measured
 * estimate ~50-100x less I/O per cohort compute.
 *
 * The old MVs are left in place (cohort_events_mv is untouched — it serves
 * the cohort events chart). Drop profile_event_summary_mv /
 * profile_event_property_summary_mv in a follow-up migration once the new
 * tables are verified.
 *
 * BACKFILL ------------------------------------------------------------------
 * populate: false — the MVs only index events inserted after CREATE. History
 * must be backfilled with the companion script (NOT auto-run; it is a
 * supervised, month-partition-aligned, resumable operation):
 *
 *   packages/db/code-migrations/backfill-resolved-cohort-mvs.ts
 *
 * Until the backfill completes, cohorts with relative timeframes compute
 * from partial data — run it promptly after deploy.
 *
 * Flags:
 *   --dry   Write the .sql artifact and print the statements; execute nothing.
 */
export async function up() {
  const replicatedVersion = '1';
  const existingTables = await getExistingTables();
  const isClustered = getIsCluster();

  const sqls: string[] = [];

  if (
    !existingTables.includes(
      `${TABLE_NAMES.event_profile_summary_mv}_distributed`,
    ) &&
    !existingTables.includes(TABLE_NAMES.event_profile_summary_mv)
  ) {
    sqls.push(
      ...createMaterializedView({
        name: TABLE_NAMES.event_profile_summary_mv,
        tableName: 'events',
        engine: 'AggregatingMergeTree()',
        orderBy: ['project_id', 'name', 'event_date', 'profile_id'],
        partitionBy: 'toYYYYMM(event_date)',
        query: `SELECT
          project_id,
          profile_id,
          name,
          toStartOfDay(created_at) AS event_date,
          countState() AS event_count,
          minState(created_at) AS first_event_time,
          maxState(created_at) AS last_event_time,
          sumState(duration) AS total_duration
        FROM {events}
        GROUP BY project_id, profile_id, name, event_date`,
        distributionHash: 'cityHash64(project_id, profile_id)',
        replicatedVersion,
        isClustered,
        populate: false,
      }),
    );
  }

  if (
    !existingTables.includes(
      `${TABLE_NAMES.event_property_profile_summary_mv}_distributed`,
    ) &&
    !existingTables.includes(TABLE_NAMES.event_property_profile_summary_mv)
  ) {
    sqls.push(
      ...createMaterializedView({
        name: TABLE_NAMES.event_property_profile_summary_mv,
        tableName: 'events',
        engine: 'AggregatingMergeTree()',
        orderBy: [
          'project_id',
          'name',
          'property_key',
          'property_value',
          'event_date',
          'profile_id',
        ],
        partitionBy: 'toYYYYMM(event_date)',
        query: `SELECT
          project_id,
          profile_id,
          name,
          property_key,
          property_value,
          toStartOfDay(created_at) AS event_date,
          countState() AS event_count,
          minState(created_at) AS first_event_time,
          maxState(created_at) AS last_event_time
        FROM {events}
        ARRAY JOIN mapKeys(properties) AS property_key, mapValues(properties) AS property_value
        WHERE property_key != ''
          AND property_value != ''
        GROUP BY project_id, profile_id, name, property_key, property_value, event_date`,
        distributionHash: 'cityHash64(project_id, profile_id)',
        replicatedVersion,
        isClustered,
        populate: false,
      }),
    );
  }

  fs.writeFileSync(
    path.join(import.meta.filename.replace('.ts', '.sql')),
    sqls
      .map((sql) =>
        sql
          .trim()
          .replace(/;$/, '')
          .replace(/\n{2,}/g, '\n')
          .concat(';'),
      )
      .join('\n\n---\n\n'),
  );

  if (process.argv.includes('--dry')) {
    console.log('🔍 DRY RUN — CREATE statements:');
    sqls.forEach((s) => console.log(`\n${s}\n`));
    return;
  }

  await runClickhouseMigrationCommands(sqls);
}

export async function down() {
  const isClustered = getIsCluster();

  const sqls = [
    dropTable(
      `${TABLE_NAMES.event_profile_summary_mv}_distributed`,
      isClustered,
    ),
    dropTable(
      `${TABLE_NAMES.event_profile_summary_mv}_replicated`,
      isClustered,
    ),
    dropTable(TABLE_NAMES.event_profile_summary_mv, isClustered),
    dropTable(
      `${TABLE_NAMES.event_property_profile_summary_mv}_distributed`,
      isClustered,
    ),
    dropTable(
      `${TABLE_NAMES.event_property_profile_summary_mv}_replicated`,
      isClustered,
    ),
    dropTable(TABLE_NAMES.event_property_profile_summary_mv, isClustered),
  ];

  await runClickhouseMigrationCommands(sqls);
}

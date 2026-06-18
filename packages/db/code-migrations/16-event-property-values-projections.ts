import { TABLE_NAMES } from '../src/clickhouse/client';
import {
  chMigrationClient,
  runClickhouseMigrationCommands,
} from '../src/clickhouse/migration';
import { getIsCluster } from './helpers';

/**
 * Perf: the property-key / property-value autocompletes scanned the ENTIRE
 * event_property_values_mv (1.57B rows on Newton prod after the Mixpanel import)
 * just to return ~6.4K distinct keys. The MV is
 * ORDER BY (project_id, name, property_key, property_value), so the project-wide
 * `SELECT DISTINCT property_key ... GROUP BY property_key` (no `name` filter)
 * can't seek and full-scans; `... WHERE property_key=? GROUP BY property_value`
 * likewise can't seek on property_key (it's behind `name`).
 *
 * Two aggregating projections let those queries read a few thousand rows:
 *   epv_keys   -> (project_id, property_key)                 max(created_at)
 *   epv_values -> (project_id, property_key, property_value) max(created_at)
 * The query optimizer rewrites the dropdown queries transparently (no app change).
 *
 * SharedAggregatingMergeTree refuses ADD PROJECTION while
 * deduplicate_merge_projection_mode = 'throw' (the default); 'rebuild' keeps the
 * projection correct across dedup-merges.
 *
 * Idempotent: ADD ... IF NOT EXISTS, and MATERIALIZE is skipped where the
 * projection already has active parts — so it's a no-op on Newton prod (first
 * applied by hand) and instant on a fresh/empty MV.
 */

const MV = TABLE_NAMES.event_property_values_mv;

const PROJECTIONS = [
  {
    name: 'epv_keys',
    def: 'SELECT project_id, property_key, max(created_at) AS created_at GROUP BY project_id, property_key',
  },
  {
    name: 'epv_values',
    def: 'SELECT project_id, property_key, property_value, max(created_at) AS created_at GROUP BY project_id, property_key, property_value',
  },
];

async function jsonRows<T>(query: string): Promise<T[]> {
  const res = await chMigrationClient.query({ query, format: 'JSONEachRow' });
  return res.json<T>();
}

// The projection lives on the MV's STORAGE table: the implicit inner table
// (`.inner_id.<uuid>`) on a single node, or `<mv>_replicated` when clustered.
async function resolveStorageTable(isClustered: boolean): Promise<string> {
  if (isClustered) {
    return `${MV}_replicated`;
  }
  const rows = await jsonRows<{ t: string }>(
    `SELECT concat('.inner_id.', toString(uuid)) AS t
     FROM system.tables WHERE database = currentDatabase() AND name = '${MV}'`,
  );
  if (!rows[0]?.t) {
    throw new Error(`${MV}: inner storage table not found`);
  }
  return rows[0].t;
}

export async function up() {
  const isClustered = getIsCluster();
  const storage = await resolveStorageTable(isClustered);
  const tbl = `\`${storage}\``;
  const onCluster = isClustered ? " ON CLUSTER '{cluster}'" : '';

  const ddl = [
    `ALTER TABLE ${tbl}${onCluster} MODIFY SETTING deduplicate_merge_projection_mode = 'rebuild'`,
    ...PROJECTIONS.map(
      (p) =>
        `ALTER TABLE ${tbl}${onCluster} ADD PROJECTION IF NOT EXISTS ${p.name} (${p.def})`,
    ),
    // Backfill existing parts. Unconditional MATERIALIZE: the migration user
    // (openpanel_writer) has ALTER but NOT SELECT on system.projection_parts, so we
    // can't read it to guard. MATERIALIZE is idempotent — it submits an async mutation
    // (does not block the migration) that recomputes the same projection data, and it's
    // instant on a fresh/empty MV. Where the projection is already materialized (e.g. a
    // hand-applied prod), the env's codeMigration record should mark this applied so it's
    // skipped instead of needlessly recomputing.
    ...PROJECTIONS.map(
      (p) => `ALTER TABLE ${tbl}${onCluster} MATERIALIZE PROJECTION ${p.name}`,
    ),
  ];

  if (process.argv.includes('--dry')) {
    console.log(ddl.join(';\n'));
    return;
  }

  await runClickhouseMigrationCommands(ddl);
}

export async function down() {
  const isClustered = getIsCluster();
  const storage = await resolveStorageTable(isClustered);
  const tbl = `\`${storage}\``;
  const onCluster = isClustered ? " ON CLUSTER '{cluster}'" : '';
  await runClickhouseMigrationCommands(
    PROJECTIONS.map(
      (p) => `ALTER TABLE ${tbl}${onCluster} DROP PROJECTION IF EXISTS ${p.name}`,
    ),
  );
}

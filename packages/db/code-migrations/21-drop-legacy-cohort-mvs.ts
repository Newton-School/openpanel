import { runClickhouseMigrationCommands } from '../src/clickhouse/migration';
import { getIsCluster } from './helpers';

/**
 * Drop the three legacy identified-only cohort/retention MVs (Newton fork).
 *
 * All were populated at INSERT with the filter
 *   (profile_id != device_id) OR profiles_is_external = 1
 * which undercounted real users two ways (anon-at-fire-time events dropped
 * forever; newton-web sends device_id == profile_id == uid so identified
 * users failed both arms). Their consumers have moved to the migration-20
 * tables (event_profile_summary_mv / event_property_profile_summary_mv:
 * identity-unfiltered, event-first sort key, device_alias resolution at
 * read, history backfilled):
 *
 *   - profile_event_summary_mv          -> cohort compute (cohort.service)
 *   - profile_event_property_summary_mv -> cohort compute (cohort.service)
 *   - cohort_events_mv                  -> retention report (trpc chart.ts)
 *
 * Dropping them also removes their insert triggers — notably the property
 * MV's per-event ARRAY JOIN, which was running twice (old + new) since
 * migration 20.
 *
 * Rollout note: between this migration applying and the new pods serving,
 * old-code cohort computes / retention queries error briefly (missing
 * table). Cohort compute self-heals on the next 30-min tick; retention is a
 * dashboard read. Accepted for a single rollout window.
 *
 * These names are intentionally literal — the TABLE_NAMES entries are
 * removed in the same release.
 */

const LEGACY_TABLES = [
  'profile_event_summary_mv',
  'profile_event_property_summary_mv',
  'cohort_events_mv',
];

function dropSqls(isClustered: boolean): string[] {
  if (!isClustered) {
    return LEGACY_TABLES.map((t) => `DROP TABLE IF EXISTS ${t}`);
  }
  return LEGACY_TABLES.flatMap((t) => [
    `DROP TABLE IF EXISTS ${t}_distributed ON CLUSTER '{cluster}'`,
    `DROP TABLE IF EXISTS ${t}_replicated ON CLUSTER '{cluster}'`,
    `DROP TABLE IF EXISTS ${t} ON CLUSTER '{cluster}'`,
  ]);
}

export async function up() {
  const sqls = dropSqls(getIsCluster());

  if (process.argv.includes('--dry')) {
    console.log('🔍 DRY RUN — DROP statements:');
    sqls.forEach((s) => console.log(`  ${s}`));
    return;
  }

  await runClickhouseMigrationCommands(sqls);
}

export async function down() {
  console.log('⚠️  No down migration — recreate via migrations 13/14/19 DDL');
  console.log('   and re-run the historical backfill if these are ever needed.');
}

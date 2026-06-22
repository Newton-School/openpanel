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
 * dicts) — RUN THAT FIRST, or this migration's ALTER fails fast (dict not found)
 * and crashloops harmlessly with the MVs unchanged.
 *
 * We `ALTER TABLE ... MODIFY QUERY` (not DROP + CREATE) so the existing MV rows
 * stay live and cohorts/retention have no downtime; only the trigger SELECT
 * changes. This makes the fix effective GOING FORWARD — every new identified
 * event now lands in the MVs.
 *
 * HISTORICAL BACKFILL IS DELIBERATELY NOT DONE HERE. The rows the old filter
 * missed (`profile_id = device_id AND identified`, ~Apr 24 2026 onward — the
 * #8100 deploy) total ~10^8 events; aggregating them into the MVs is a multi-
 * hour job and, because these are AggregatingMergeTree, NOT restart-safe (a re-
 * run sums state again → double counts). Running that inside the migration's
 * init container — which k8s/Karpenter can evict mid-run, triggering a full
 * re-run — risks exactly that. It is therefore a separate, supervised, resumable
 * operation (chunked INSERT ... SELECT with the same column projections + the
 * `profile_id = device_id AND identified` delta predicate, run once after this
 * migration applies). See the rollout notes / runbook.
 *
 * NOTE — the sort keys are intentionally left unchanged: these MVs are shared
 * with other access paths and reordering could regress them. A cohort query
 * therefore still scans the (now larger) project slice; measured impact ~2-2.8x
 * on a sub-second query — acceptable for cohort-save / report-load paths.
 *
 * Flags:
 *   --dry   Write the .sql artifact and print the statements; execute nothing.
 */

const DB = 'openpanel';

const isClustered = getIsCluster();
const isDry = process.argv.includes('--dry');

// Whichever side the original MVs read from (the helper replaces {events}).
const eventsTable = isClustered ? 'events_replicated' : 'events';

// The new "identified user" predicate shared by all three MVs.
const IDENTIFIED = `(profile_id != device_id OR dictGetOrDefault('${DB}.profiles_is_external', 'is_external', (project_id, profile_id), toUInt8(0)) = 1)`;

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

function modifyQuerySql(mv: string, where: string): string {
  // In clustered mode the writer is the *_replicated MV; non-clustered it's the
  // MV object itself. ON CLUSTER fans the DDL to every replica.
  const target = isClustered ? `${mv}_replicated` : mv;
  const onCluster = isClustered ? ` ON CLUSTER '{cluster}'` : '';
  const select = SELECTS[mv]!.select(whereFor(mv, where));
  return `ALTER TABLE ${DB}.${target}${onCluster} MODIFY QUERY\n${select}`;
}

export async function up() {
  const modifyQueries = Object.keys(SELECTS).map((mv) =>
    modifyQuerySql(mv, IDENTIFIED),
  );

  // Persist the schema-change SQL alongside the migration (same convention as 18).
  fs.writeFileSync(
    path.join(import.meta.filename.replace('.ts', '.sql')),
    modifyQueries.map((s) => s.trim().concat(';')).join('\n\n---\n\n'),
  );

  if (isDry) {
    console.log('🔍 DRY RUN — MODIFY QUERY statements:');
    modifyQueries.forEach((s) => console.log(`\n${s}\n`));
    return;
  }

  console.log('⚡️ Applying MODIFY QUERY to the 3 MVs (no data dropped)…');
  await runClickhouseMigrationCommands(modifyQueries);
  console.log(
    '✅ MV filter updated (go-forward). Run the historical backfill separately — see runbook.',
  );
}

export async function down() {
  // Revert the trigger SELECTs to the original `profile_id != device_id` filter.
  // (Any rows already materialised under the new filter are left in place; they
  // simply stop being added going forward.)
  const revert = Object.keys(SELECTS).map((mv) =>
    modifyQuerySql(mv, 'profile_id != device_id'),
  );
  await runClickhouseMigrationCommands(revert);
}

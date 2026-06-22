-- ============================================================================
-- 19-identified-events-in-profile-mvs.admin.sql   (Newton fork)
--
-- ONE-TIME ADMIN SETUP for the "identified events missing from cohort/retention
-- MVs" fix. RUN AS THE CLICKHOUSE CLOUD `default` USER, once per environment,
-- BEFORE code-migration 19.
--
-- Why this exists -----------------------------------------------------------
-- profile_event_summary_mv, profile_event_property_summary_mv and
-- cohort_events_mv filter `WHERE profile_id != device_id` to mean "identified
-- user" (anonymous events default profile_id = device_id at ingestion — see
-- track.controller.ts: `profileId = payload.profileId ?? context.deviceId`).
--
-- PR newton-web#8100 ("pin __deviceId to user uid") made identified events also
-- carry device_id = profile_id (= uid), so they now FAIL `profile_id != device_id`
-- and are silently dropped from cohorts + the retention report (~97% of
-- identified events). This dictionary lets the MVs recognise identified users by
-- their profile flag instead of inferring it from device_id.
--
-- Why not in the code migration: on ClickHouse Cloud a dictionary with a
-- CLICKHOUSE source must be created by `default` (a non-default user must supply
-- explicit credentials). Same constraint as device_alias (migration 18).
--
-- ORDER OF OPERATIONS per environment:
--   1) Run THIS file as `default`.
--   2) Run code-migration 19 (ALTER ... MODIFY QUERY on the 3 MVs + backfill).
-- ============================================================================

-- In-memory hashed map of identified profiles: (project_id, id) -> 1.
-- Only is_external = 1 (identified) rows are loaded; everyone else falls through
-- to the dictGetOrDefault(..., 0) in the MV filter and stays excluded. Source is
-- ~2.85M rows (identified profiles) so the resident hash table is a few hundred
-- MB. LIFETIME reloads hourly to pick up newly-identified profiles.
DROP DICTIONARY IF EXISTS openpanel.profiles_is_external;

CREATE DICTIONARY openpanel.profiles_is_external
(
  project_id String,
  id String,
  is_external UInt8
)
PRIMARY KEY project_id, id
-- NOTE: the filter MUST be in a subquery. `SELECT toUInt8(1) AS is_external ... WHERE is_external = 1`
-- makes the output alias (constant 1) shadow the table column in the WHERE, so it filters 1=1 and
-- loads EVERY profile (anon included) with is_external=1 — silently breaking the dict. The subquery
-- keeps the WHERE bound to the real column, so only identified profiles load.
SOURCE(CLICKHOUSE(QUERY 'SELECT project_id, id, toUInt8(1) AS is_external FROM (SELECT project_id, id FROM openpanel.profiles FINAL WHERE is_external = 1)'))
LAYOUT(COMPLEX_KEY_HASHED())
LIFETIME(MIN 3000 MAX 3600);

-- The MV SELECTs run in the context of the user INSERTing into `events` (the
-- ingestion writer) and, for the historical backfill, the migration user. Grant
-- dictGet to both so the MV trigger and the backfill can resolve the flag.
-- Adjust the grantee list to match the actual ingestion user in this environment.
GRANT dictGet ON openpanel.profiles_is_external TO openpanel_writer;
GRANT dictGet ON openpanel.profiles_is_external TO openpanel_reader;

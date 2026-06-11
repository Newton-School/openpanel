-- ============================================================================
-- 16-profile-alias-resolution.admin.sql   (Newton fork)
--
-- ONE-TIME ADMIN SETUP for query-time anonymous -> identified profile
-- resolution. RUN AS THE CLICKHOUSE CLOUD `default` USER, once per environment.
--
-- Why not in the code migration: on ClickHouse Cloud a dictionary's CLICKHOUSE
-- source requires the `default` user (a non-default user must supply explicit
-- credentials). The migration's service user (openpanel_writer) therefore
-- cannot create the dictionary. The dict and the table are dependency-coupled
-- (the dict SOURCE reads the table), so they are set up together here.
--
-- ORDER OF OPERATIONS per environment:
--   1) Run THIS file as `default`.
--   2) Run code-migration 16 (creates the `events_resolved` view).
--   3) Deploy the worker with NEWTON_PROFILE_ALIAS_DISCOVERY=1 (cron fills
--      profile_aliases), then flip NEWTON_RESOLVE_PROFILE=1 to route reads
--      through the view.
--
-- Verified on prod Cloud: cookie -> uid, 32-char IP+UA hash -> unchanged,
-- reader role resolves through the view.
-- ============================================================================

-- Drop dependents before dependencies (dict SOURCE depends on the table; the
-- view references the dict by name). Safe to re-run.
DROP VIEW IF EXISTS openpanel.events_resolved;
DROP DICTIONARY IF EXISTS openpanel.device_alias;
DROP TABLE IF EXISTS openpanel.profile_aliases;

-- 1) Durable cookie -> uid map. ReplacingMergeTree(created_at) keeps the latest
--    uid per cookie; ORDER BY (project_id, alias) makes dictionary cache-miss
--    lookups indexed point reads. TTL ages out cookies not seen within the
--    analytical window (the discovery cron re-inserts active ones).
CREATE TABLE openpanel.profile_aliases
(
  project_id String,
  profile_id String,   -- the uid (canonical identity)
  alias String,        -- the 16-hex op_device_id cookie
  created_at DateTime DEFAULT now()
)
ENGINE = ReplacingMergeTree(created_at)
ORDER BY (project_id, alias)
TTL created_at + INTERVAL 540 DAY
SETTINGS index_granularity = 8192;

-- 2) Lazy, RAM-bounded cache dictionary: (project_id, cookie) -> uid.
--    COMPLEX_KEY_CACHE: populated on demand, LRU-evicts cold keys, never
--    eager-loads the whole map. SIZE_IN_CELLS bounds RAM (~2 GB worst case).
--    allow_read_expired_keys: serve a stale value + refresh async (no per-row
--    stall). FINAL on the ReplacingMergeTree source yields the latest uid per
--    cookie; the cache-miss key filter pushes into the (project_id, alias) PK.
CREATE DICTIONARY openpanel.device_alias
(
  project_id String,
  alias String,
  profile_id String
)
PRIMARY KEY project_id, alias
SOURCE(CLICKHOUSE(QUERY 'SELECT project_id, alias, profile_id FROM openpanel.profile_aliases FINAL'))
LAYOUT(COMPLEX_KEY_CACHE(SIZE_IN_CELLS 8388608))
LIFETIME(MIN 3000 MAX 3600)
SETTINGS(allow_read_expired_keys = 1);

-- 3) Let the dashboard (reader) resolve through the dictionary.
GRANT dictGet ON openpanel.device_alias TO openpanel_reader;

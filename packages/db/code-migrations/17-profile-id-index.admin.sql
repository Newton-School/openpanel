-- Newton fork: ADMIN one-time step for migration 17 (profile_id bloom index).
--
-- Migration 17 (17-profile-id-index.ts) only ADDs the index, which applies to
-- newly-written parts. For an environment whose events table already holds data
-- (e.g. prod after the historical backfill), the index must also be built for
-- EXISTING parts. That is a mutation — heavy, async, and a one-time op — so it
-- is NOT in the migration (which would otherwise re-materialize on every run).
--
-- Run ONCE per such environment, AFTER migration 17's ADD INDEX. Building only
-- reads the profile_id column and writes small .idx files; it does NOT rewrite
-- the table data (unlike a projection). On ClickHouse Cloud this consumes
-- compute, so run it deliberately and watch system.mutations until is_done=1.
--
-- Status: run on prod 2026-06-12 (mutation 0000000005, completed).

ALTER TABLE openpanel.events MATERIALIZE INDEX idx_profile_id;

-- Watch progress:
--   SELECT mutation_id, is_done, parts_to_do, latest_fail_reason
--   FROM system.mutations
--   WHERE table = 'events' AND command LIKE '%idx_profile_id%';

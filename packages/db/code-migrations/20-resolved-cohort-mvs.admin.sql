-- Companion to migration 20 (resolved cohort MVs) — run as the `default`
-- (admin) user, same convention as 18/19 admin files.
--
-- The migration-20 cohort compute and the migration-21-era retention query
-- call dictGetOrDefault('openpanel.device_alias', ...) DIRECTLY, as the
-- invoking app user. Unlike reads through the events_resolved view (definer
-- security), direct dictionary access requires an explicit dictGet grant —
-- without it every event-based cohort compute fails with:
--   "Not enough privileges. To execute this query, it's necessary to have
--    the grant dictGet ON openpanel.device_alias."
--
-- APPLIED ON PROD: 2026-07-02 (openpanel_reader already had it from the
-- migration-18 rollout; openpanel_writer — the worker's user — did not).

GRANT dictGet ON openpanel.device_alias TO openpanel_writer;

GRANT dictGet ON openpanel.device_alias TO openpanel_reader;

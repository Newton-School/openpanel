/**
 * Newton fork: id-shape classification for anonymous -> identified profile
 * resolution (see migration 16 + cron.profile-alias).
 *
 * In our data the LENGTH of an id is the reliable identity signal — far more
 * reliable than the `is_external` flag, which is corrupted for the uid-override
 * era (a real user can have a stale is_external=false version). The three
 * shapes:
 *   - 10 chars  -> a Newton uid            => IDENTIFIED
 *   - 16 chars  -> an `op_device_id` cookie => anonymous, SAFE to resolve
 *                  (reset on logout, so single-owner by construction)
 *   - 32 chars  -> a server IP+UA hash      => anonymous, NEVER resolve
 *                  (shared across every user behind the same NAT+UA)
 *
 * The resolution map is keyed on the 16-char cookie only; a 32-char hash must
 * never enter it, or we resurrect the cross-user profile bleed.
 */

import sqlstring from 'sqlstring';
import { chQuery, TABLE_NAMES } from '../clickhouse/client';

/**
 * The resolved identity of a raw `profile_id`: folded through the
 * device_alias dictionary — identical semantics to the events_resolved view.
 * For use in queries against raw tables/MVs that carry an unresolved
 * profile_id (cohort compute, retention). Requires `GRANT dictGet ON
 * openpanel.device_alias` for the querying user (see migration 20 admin.sql).
 */
export const RESOLVED_PROFILE_ID_SQL = `dictGetOrDefault('openpanel.device_alias', 'profile_id', (project_id, profile_id), profile_id)`;

/**
 * Current members of a cohort = rows from the LATEST compute only.
 * cohort_members is a ReplacingMergeTree that storeCohortMembership only ever
 * INSERTs into — a profile that stops matching keeps its old row forever, so
 * an unversioned read reports departed members as still present (visibly
 * wrong for rolling-window cohorts like "fired X in the last 7 days").
 * Filtering to max(version) — the compute run id — restores exact semantics.
 */
export function currentCohortMembersSql(
  projectId: string,
  cohortId: string
): string {
  const pid = sqlstring.escape(projectId);
  const cid = sqlstring.escape(cohortId);
  return `SELECT profile_id FROM ${TABLE_NAMES.cohort_members} FINAL
    WHERE project_id = ${pid} AND cohort_id = ${cid}
      AND version = (
        SELECT max(version) FROM ${TABLE_NAMES.cohort_members} FINAL
        WHERE project_id = ${pid} AND cohort_id = ${cid}
      )`;
}

export const IDENTITY_ID_LENGTH = 10;
export const COOKIE_ID_LENGTH = 16;
export const SERVER_HASH_ID_LENGTH = 32;

export const isIdentityId = (id: string): boolean =>
  id.length === IDENTITY_ID_LENGTH;

export const isCookieId = (id: string): boolean =>
  id.length === COOKIE_ID_LENGTH;

export const isServerHashId = (id: string): boolean =>
  id.length === SERVER_HASH_ID_LENGTH;

/**
 * Whether a device id is safe to map to a uid. Only the per-browser cookie
 * qualifies — never the shared server hash.
 */
export const isResolvableAlias = (deviceId: string): boolean =>
  isCookieId(deviceId);

/**
 * Set-expansion: a SQL predicate matching a profile's identified id PLUS its
 * resolved anonymous cookie ids (aliases), evaluated against the RAW
 * `events.profile_id` column.
 *
 * Why not just read the `events_resolved` view and filter `profile_id = uid`?
 * On the view `profile_id` is a `dictGet(...)` expression, so the predicate
 * lands on a *computed* column — the `profile_id` skip-index can no longer
 * prune, and every such filter degrades to a full-table scan (this is what hung
 * the profile panel for ~8 min). Here we invert the alias map ourselves into an
 * `IN (uid, ...aliases)` over the raw, indexed column. ClickHouse evaluates the
 * IN-subquery to a set and uses it for index pruning, so the lookup stays fast
 * AND the cookie's pre-login events still fold into the profile.
 *
 * Safety: only 16-char cookies are ever aliases (see the cron's uniqExact gate);
 * 32-char IP+UA hashes are never in `profile_aliases`, so they can never be
 * pulled in here — no cross-user bleed.
 *
 * Note: the caller still constrains `project_id` on the outer query — a uid is
 * only project-unique, and we must not count its events under another project.
 */
export function profileIdInClause(
  column: string,
  projectId: string,
  profileId: string
): string {
  const pid = sqlstring.escape(projectId);
  const uid = sqlstring.escape(profileId);
  return `${column} IN (
    SELECT ${uid}
    UNION DISTINCT
    SELECT alias FROM ${TABLE_NAMES.alias} FINAL
    WHERE project_id = ${pid} AND profile_id = ${uid}
  )`;
}

/**
 * Literal-list variant of the set-expansion, for hot paths: fetch the alias
 * literals once (a tiny indexed read of `profile_aliases`) and let callers
 * embed a CONSTANT `IN (...)` in their events queries via inLiterals().
 *
 * Why prefer this over profileIdInClause's IN-subquery when a request runs
 * SEVERAL events queries for the same profile (verified on prod):
 *   1. The bloom index prunes a constant set the tightest.
 *   2. Identical constant predicates share the query-condition cache across
 *      queries/CTEs; an IN-subquery re-evaluates per query — the original
 *      13-CTE getProfileMetrics paid ~13 scans instead of ~1 this way.
 */
export async function getProfileMatchIds(
  projectId: string,
  profileId: string
): Promise<string[]> {
  const rows = await chQuery<{ alias: string }>(
    `SELECT alias FROM ${TABLE_NAMES.alias} FINAL
     WHERE project_id = ${sqlstring.escape(projectId)}
       AND profile_id = ${sqlstring.escape(profileId)}`
  );
  return [profileId, ...rows.map((r) => r.alias)];
}

export function inLiterals(column: string, ids: string[]): string {
  return `${column} IN (${ids.map((id) => sqlstring.escape(id)).join(', ')})`;
}

/**
 * Same inversion for cohort membership: match a cohort's member uids PLUS each
 * member's resolved cookie aliases, against raw `events.profile_id`. Lets a
 * cohort-filtered event list/count include members' pre-login (anonymous)
 * events without paying the per-row dictGet of the view.
 */
export function cohortMembersInClause(
  column: string,
  projectId: string,
  cohortId: string
): string {
  const pid = sqlstring.escape(projectId);
  const members = currentCohortMembersSql(projectId, cohortId);
  return `${column} IN (
    ${members}
    UNION DISTINCT
    SELECT alias FROM ${TABLE_NAMES.alias} FINAL
    WHERE project_id = ${pid} AND profile_id IN (${members})
  )`;
}

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
import { TABLE_NAMES } from '../clickhouse/client';

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
  const cid = sqlstring.escape(cohortId);
  const members = `SELECT profile_id FROM ${TABLE_NAMES.cohort_members} FINAL WHERE cohort_id = ${cid} AND project_id = ${pid}`;
  return `${column} IN (
    ${members}
    UNION DISTINCT
    SELECT alias FROM ${TABLE_NAMES.alias} FINAL
    WHERE project_id = ${pid} AND profile_id IN (${members})
  )`;
}

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

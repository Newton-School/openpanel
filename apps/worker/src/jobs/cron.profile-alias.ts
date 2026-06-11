import {
  COOKIE_ID_LENGTH,
  ch,
  chQuery,
  formatClickhouseDate,
  IDENTITY_ID_LENGTH,
} from '@openpanel/db';
import { getRedisCache } from '@openpanel/redis';
import sqlstring from 'sqlstring';
import { logger as baseLogger } from '@/utils/logger';

const logger = baseLogger.child({ job: 'profileAlias' });

const WATERMARK_KEY = 'newton:profile-alias:watermark';
// Cookie era began ~2026-06-10; nothing before this carries the 16-hex
// `op_device_id` cookie, so there is no point scanning the (huge, imported)
// historical data. Overridable for replays.
const DEFAULT_START = process.env.NEWTON_PROFILE_ALIAS_START ?? '2026-06-10 00:00:00';
const WINDOW_MS = 24 * 60 * 60 * 1000; // one day per chunk
const MAX_CHUNKS_PER_RUN = 7; // catch up ~a week per 5-min tick, then steady state

interface AliasRow {
  project_id: string;
  alias: string;
  // argMax aliased to `uid` (not `profile_id`) to avoid shadowing the
  // profile_id column referenced in WHERE — ClickHouse would otherwise reject
  // it as "aggregate function in WHERE".
  uid: string;
}

function projectFilter(): string {
  const projects = (process.env.NEWTON_PROFILE_ALIAS_PROJECTS ?? '')
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);
  if (projects.length === 0) {
    return '';
  }
  return `AND project_id IN (${projects.map((p) => sqlstring.escape(p)).join(', ')})`;
}

/**
 * Discover shared-cookie -> uid links and record them in `profile_aliases`.
 *
 * The map is derived from IDENTIFIED events: a 10-char `profile_id` (the uid)
 * that carries a 16-char `__deviceId` (the cookie R). We never touch events.
 *
 * Safety: `HAVING uniqExact(profile_id) = 1` drops any cookie that maps to more
 * than one uid within the window (shared device / failed logout reset) — those
 * stay anonymous rather than mis-merging. The query reads `properties.__deviceId`
 * (not the `device_id` column), so it is robust to the earlier device_id
 * backfill that clobbered that column.
 *
 * Bounded: a day-chunked watermark, at most MAX_CHUNKS_PER_RUN windows per tick,
 * each scan capped to one day's partition slice — independent of total table size.
 */
export async function profileAliasDiscovery() {
  const redis = getRedisCache();
  const stored = await redis.get(WATERMARK_KEY);
  let from = stored ? new Date(stored) : new Date(DEFAULT_START);
  const now = Date.now();
  const pFilter = projectFilter();

  let chunks = 0;
  let totalInserted = 0;

  while (chunks < MAX_CHUNKS_PER_RUN && from.getTime() < now) {
    const to = new Date(Math.min(from.getTime() + WINDOW_MS, now));

    const rows = await chQuery<AliasRow>(
      `SELECT
         project_id,
         properties['__deviceId'] AS alias,
         argMax(profile_id, created_at) AS uid
       FROM events
       WHERE created_at >= ${sqlstring.escape(formatClickhouseDate(from))}
         AND created_at < ${sqlstring.escape(formatClickhouseDate(to))}
         AND length(profile_id) = ${IDENTITY_ID_LENGTH}
         AND length(properties['__deviceId']) = ${COOKIE_ID_LENGTH}
         AND properties['__deviceId'] != profile_id
         ${pFilter}
       GROUP BY project_id, alias
       HAVING uniqExact(profile_id) = 1`
    );

    if (rows.length > 0) {
      const createdAt = formatClickhouseDate(new Date());
      await ch.insert({
        table: 'profile_aliases',
        values: rows.map((r) => ({
          project_id: r.project_id,
          profile_id: r.uid,
          alias: r.alias,
          created_at: createdAt,
        })),
        format: 'JSONEachRow',
      });
      totalInserted += rows.length;
    }

    from = to;
    chunks += 1;
    await redis.set(WATERMARK_KEY, from.toISOString());
  }

  logger.info('profileAlias discovery run complete', {
    chunks,
    totalInserted,
    watermark: from.toISOString(),
    caughtUp: from.getTime() >= now,
  });
}

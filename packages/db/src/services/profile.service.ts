import { strip, toObject } from '@openpanel/common';
import { cacheable } from '@openpanel/redis';
import type { IChartEventFilter } from '@openpanel/validation';
import { uniq } from 'ramda';
import sqlstring from 'sqlstring';
import { profileBuffer } from '../buffers';
import {
  ch,
  chQuery,
  convertClickhouseDateToJs,
  formatClickhouseDate,
  isClickhouseDefaultMinDate,
  TABLE_NAMES,
} from '../clickhouse/client';
import { clix } from '../clickhouse/query-builder';
import {
  getProfileMatchIds,
  inLiterals,
  profileIdInClause,
} from './profile-resolution';
import { createSqlBuilder } from '../sql-builder';
import type { IClickhouseEvent } from './event.service';
import type { IClickhouseSession } from './session.service';

export interface IProfileMetrics {
  lastSeen: Date | null;
  firstSeen: Date | null;
  screenViews: number;
  sessions: number;
  durationAvg: number;
  durationP90: number;
  totalEvents: number;
  uniqueDaysActive: number;
  bounceRate: number;
  avgEventsPerSession: number;
  conversionEvents: number;
  avgTimeBetweenSessions: number;
  revenue: number;
}
export async function getProfileMetrics(profileId: string, projectId: string) {
  // Newton fork: ONE scan over RAW events with conditional aggregates, matching
  // the profile's identified id + its resolved cookie aliases as a CONSTANT
  // IN-list (anon pre-login events fold in).
  //
  // Two prod-verified pitfalls shaped this:
  //  - events_resolved + `profile_id = X` turns profile_id into a dictGet
  //    column -> the bloom index can't prune -> full 163M-row scan per CTE.
  //  - 13 CTEs each with an IN-SUBQUERY predicate re-scan independently (no
  //    query-condition-cache sharing) -> ~13x the reads of the old `= X` shape.
  // A single pass + literal IN-list avoids both: one scan, tightest bloom
  // pruning. Derived metrics are computed from the aggregates in a wrapper
  // SELECT, preserving the old per-CTE semantics (nullIf guards, defaults).
  const pid = sqlstring.escape(projectId);
  const match = inLiterals(
    'profile_id',
    await getProfileMatchIds(projectId, profileId)
  );
  return chQuery<
    Omit<IProfileMetrics, 'lastSeen' | 'firstSeen'> & {
      lastSeen: string;
      firstSeen: string;
    }
  >(`
    SELECT
      *,
      round(totalEvents / nullIf(sessions, 0), 2) as avgEventsPerSession,
      CASE
        WHEN sessions <= 1 THEN 0
        ELSE round(dateDiff('second', firstSeen, lastSeen) / nullIf(sessions - 1, 0), 1)
      END as avgTimeBetweenSessions
    FROM (
      SELECT
        max(created_at) as lastSeen,
        min(created_at) as firstSeen,
        countIf(name = 'screen_view') as screenViews,
        countIf(name = 'session_start') as sessions,
        round(avgIf(duration, name = 'session_end' AND duration != 0) / 1000 / 60, 2) as durationAvg,
        round(quantilesExactInclusiveIf(0.9)(duration, name = 'session_end' AND duration != 0)[1] / 1000 / 60, 2) as durationP90,
        count(*) as totalEvents,
        count(DISTINCT toDate(created_at)) as uniqueDaysActive,
        round(avgIf(properties['__bounce'] = '1', name = 'session_end') * 100, 4) as bounceRate,
        countIf(name NOT IN ('screen_view', 'session_start', 'session_end')) as conversionEvents,
        sumIf(revenue, name = 'revenue') as revenue
      FROM ${TABLE_NAMES.events}
      WHERE project_id = ${pid} AND ${match}
    )
  `)
    .then((data) => data[0]!)
    .then((data) => {
      return {
        ...data,
        lastSeen: isClickhouseDefaultMinDate(data.lastSeen)
          ? null
          : convertClickhouseDateToJs(data.lastSeen),
        firstSeen: isClickhouseDefaultMinDate(data.firstSeen)
          ? null
          : convertClickhouseDateToJs(data.firstSeen),
      };
    });
}

export async function getProfileById(id: string, projectId: string) {
  if (id === '' || projectId === '') {
    return null;
  }

  const cachedProfile = await profileBuffer.fetchFromCache(id, projectId);
  if (cachedProfile) {
    return transformProfile(cachedProfile);
  }

  const [profile] = await chQuery<IClickhouseProfile>(
    `SELECT 
      id, 
      project_id,
      last_value(nullIf(first_name, '')) as first_name, 
      last_value(nullIf(last_name, '')) as last_name, 
      last_value(nullIf(email, '')) as email, 
      last_value(nullIf(avatar, '')) as avatar, 
      last_value(is_external) as is_external, 
      last_value(properties) as properties, 
      last_value(created_at) as created_at
    FROM ${TABLE_NAMES.profiles} FINAL WHERE id = ${sqlstring.escape(String(id))} AND project_id = ${sqlstring.escape(projectId)} GROUP BY id, project_id ORDER BY created_at DESC LIMIT 1`
  );

  if (!profile) {
    return null;
  }

  return transformProfile(profile);
}

interface GetProfileListOptions {
  projectId: string;
  take: number;
  cursor?: number;
  filters?: IChartEventFilter[];
  search?: string;
  isExternal?: boolean;
}

export async function getProfiles(ids: string[], projectId: string) {
  const filteredIds = uniq(ids.filter((id) => id !== ''));

  if (filteredIds.length === 0) {
    return [];
  }

  // Newton fork: a profile has one row per update in this ReplacingMergeTree,
  // and `any()` returned an arbitrary one, so ~6% of profiles (those with an
  // update history) came back with an old row: missing city, missing custom
  // properties, stale name. The profile page reads with FINAL and shows the
  // latest, which is why exports and the View Users list disagreed with it.
  //
  // FINAL here costs 4-5GB read per 500-id batch on prod (it merges whole
  // ranges), against ~1.6GB for the plain scan, so instead pick the newest
  // row per profile with argMax. The version column, created_at, is the
  // profile's creation time and ties across updates for ~5% of profiles, so
  // the tie-break is the row with the most properties: updates merge
  // properties in, so the fullest row is the latest one. All columns are
  // taken from that single row (argMax over a tuple), never mixed.
  const rowKey = '(created_at, length(properties))';
  const rowTuple =
    'tuple(nullIf(first_name, \'\'), nullIf(last_name, \'\'), nullIf(email, \'\'), nullIf(avatar, \'\'), is_external, properties, created_at, groups)';
  const data = await chQuery<IClickhouseProfile>(
    `SELECT
      id,
      project_id,
      tupleElement(latest, 1) as first_name,
      tupleElement(latest, 2) as last_name,
      tupleElement(latest, 3) as email,
      tupleElement(latest, 4) as avatar,
      tupleElement(latest, 5) as is_external,
      tupleElement(latest, 6) as properties,
      tupleElement(latest, 7) as created_at,
      tupleElement(latest, 8) as groups
    FROM (
      SELECT id, project_id, argMax(${rowTuple}, ${rowKey}) as latest
      FROM ${TABLE_NAMES.profiles}
      WHERE
        project_id = ${sqlstring.escape(projectId)} AND
        id IN (${filteredIds.map((id) => sqlstring.escape(id)).join(',')})
      GROUP BY id, project_id
    )
    `
  );

  return data.map(transformProfile);
}

export const getProfilesCached = cacheable(getProfiles, 60 * 5);

export interface LastSeenScope {
  /** Event names to consider; empty = any event. */
  eventNames: string[];
  /** ClickHouse-formatted bounds (YYYY-MM-DD HH:MM:SS). */
  startDate: string;
  endDate: string;
}

/**
 * Last time each profile performed one of the given events inside the given
 * window, from the per-profile summary MV. Used by the "View Users" CSV
 * export as its `last_seen` column.
 *
 * The scope is mandatory on purpose: the MV is keyed
 * (project_id, name, event_date, profile_id), so a lookup by profile id
 * alone scans the whole project (measured on prod: 105M rows, up to 4.7s per
 * 500-id batch). With names and dates in the WHERE the primary key prunes
 * it to the report's own granules (same lookup: 0.66M rows, 27ms).
 * Profiles with no matching row are absent from the map.
 */
export async function getProfilesLastSeen(
  ids: string[],
  projectId: string,
  scope: LastSeenScope,
): Promise<Map<string, Date>> {
  const filteredIds = uniq(ids.filter((id) => id !== ''));
  const result = new Map<string, Date>();
  if (filteredIds.length === 0) {
    return result;
  }
  const nameFilter = scope.eventNames.length
    ? `AND name IN (${scope.eventNames.map((n) => sqlstring.escape(n)).join(',')})`
    : '';
  // Keep each IN list well under max_query_size.
  const BATCH_SIZE = 500;
  for (let i = 0; i < filteredIds.length; i += BATCH_SIZE) {
    const batch = filteredIds.slice(i, i + BATCH_SIZE);
    const rows = await chQuery<{ profile_id: string; last_seen: string }>(
      `SELECT profile_id, maxMerge(last_event_time) AS last_seen
       FROM ${TABLE_NAMES.event_profile_summary_mv}
       WHERE project_id = ${sqlstring.escape(projectId)}
         ${nameFilter}
         AND event_date BETWEEN toDateTime(${sqlstring.escape(scope.startDate)}) AND toDateTime(${sqlstring.escape(scope.endDate)})
         AND profile_id IN (${batch.map((id) => sqlstring.escape(id)).join(',')})
       GROUP BY profile_id`,
    );
    for (const row of rows) {
      result.set(row.profile_id, convertClickhouseDateToJs(row.last_seen));
    }
  }
  return result;
}

export async function getProfileList({
  take,
  cursor,
  projectId,
  search,
  isExternal,
}: GetProfileListOptions) {
  const { sb, getSql } = createSqlBuilder();
  sb.from = `${TABLE_NAMES.profiles} FINAL`;
  sb.select.all = '*';
  sb.where.project_id = `project_id = ${sqlstring.escape(projectId)}`;
  sb.limit = take;
  sb.offset = Math.max(0, (cursor ?? 0) * take);
  sb.orderBy.created_at = 'created_at DESC';
  if (search) {
    sb.where.search = `(email ILIKE '%${search}%' OR first_name ILIKE '%${search}%' OR last_name ILIKE '%${search}%')`;
  }
  if (isExternal !== undefined) {
    sb.where.external = `is_external = ${isExternal ? 'true' : 'false'}`;
  }
  const data = await chQuery<IClickhouseProfile>(getSql());
  return data.map(transformProfile);
}

export async function getProfileListCount({
  projectId,
  isExternal,
  search,
}: Omit<GetProfileListOptions, 'cursor' | 'take'>) {
  const { sb, getSql } = createSqlBuilder();
  sb.from = 'profiles';
  sb.select.count = 'count(id) as count';
  sb.where.project_id = `project_id = ${sqlstring.escape(projectId)}`;
  sb.groupBy.project_id = 'project_id';
  if (search) {
    sb.where.search = `(email ILIKE '%${search}%' OR first_name ILIKE '%${search}%' OR last_name ILIKE '%${search}%')`;
  }
  if (isExternal !== undefined) {
    sb.where.external = `is_external = ${isExternal ? 'true' : 'false'}`;
  }
  const data = await chQuery<{ count: number }>(getSql());
  return data[0]?.count ?? 0;
}

export interface IServiceProfile {
  id: string;
  email: string;
  avatar: string;
  firstName: string;
  lastName: string;
  createdAt: Date;
  isExternal: boolean;
  projectId: string;
  groups: string[];
  properties: Record<string, unknown> & {
    region?: string;
    country?: string;
    city?: string;
    os?: string;
    os_version?: string;
    browser?: string;
    browser_version?: string;
    referrer_name?: string;
    referrer_type?: string;
    device?: string;
    brand?: string;
    model?: string;
    referrer?: string;
  };
}

export interface IClickhouseProfile {
  id: string;
  first_name: string;
  last_name: string;
  email: string;
  avatar: string;
  properties: Record<string, string | undefined>;
  project_id: string;
  is_external: boolean;
  created_at: string;
  groups: string[];
}

export interface IServiceUpsertProfile {
  projectId: string;
  id: string | number;
  firstName?: string;
  lastName?: string;
  email?: string;
  avatar?: string;
  properties?: Record<string, unknown>;
  isExternal: boolean;
  groups?: string[];
}

export function transformProfile({
  created_at,
  first_name,
  last_name,
  ...profile
}: IClickhouseProfile): IServiceProfile {
  return {
    firstName: first_name,
    lastName: last_name,
    isExternal: profile.is_external,
    properties: toObject(profile.properties),
    createdAt: convertClickhouseDateToJs(created_at),
    projectId: profile.project_id,
    id: profile.id,
    email: profile.email,
    avatar: profile.avatar,
    groups: profile.groups ?? [],
  };
}

export function upsertProfile(
  {
    id,
    firstName,
    lastName,
    email,
    avatar,
    properties,
    projectId,
    isExternal,
    groups,
  }: IServiceUpsertProfile,
  isFromEvent = false
) {
  const profile: IClickhouseProfile = {
    id: String(id),
    first_name: firstName || '',
    last_name: lastName || '',
    email: email || '',
    avatar: avatar || '',
    properties: strip((properties as Record<string, string | undefined>) || {}),
    project_id: projectId,
    created_at: formatClickhouseDate(new Date()),
    is_external: isExternal,
    groups: groups ?? [],
  };

  return profileBuffer.add(profile, isFromEvent);
}

const PROFILE_COLUMNS =
  'id, first_name, last_name, email, avatar, properties, project_id, is_external, created_at, groups';

export interface FindProfilesInput {
  projectId: string;
  name?: string;
  email?: string;
  country?: string;
  city?: string;
  device?: string;
  browser?: string;
  inactiveDays?: number;
  minSessions?: number;
  performedEvent?: string;
  sortBy?: 'created_at';
  sortOrder?: 'asc' | 'desc';
  limit?: number;
}

export function findProfilesCore(
  input: FindProfilesInput
): Promise<IClickhouseProfile[]> {
  const pid = sqlstring.escape(input.projectId);
  const conditions: string[] = [`project_id = ${pid}`];

  if (input.email) {
    conditions.push(`email LIKE ${sqlstring.escape(`%${input.email}%`)}`);
  }
  if (input.name) {
    const escaped = sqlstring.escape(`%${input.name}%`);
    conditions.push(
      `(first_name LIKE ${escaped} OR last_name LIKE ${escaped})`
    );
  }
  if (input.country) {
    conditions.push(
      `properties['country'] = ${sqlstring.escape(input.country)}`
    );
  }
  if (input.city) {
    conditions.push(`properties['city'] = ${sqlstring.escape(input.city)}`);
  }
  if (input.device) {
    conditions.push(`properties['device'] = ${sqlstring.escape(input.device)}`);
  }
  if (input.browser) {
    conditions.push(
      `properties['browser'] = ${sqlstring.escape(input.browser)}`
    );
  }

  if (input.inactiveDays !== undefined) {
    const days = Math.floor(input.inactiveDays);
    conditions.push(`id NOT IN (
      SELECT DISTINCT profile_id FROM ${TABLE_NAMES.eventsRead}
      WHERE project_id = ${pid}
        AND profile_id != ''
        AND created_at >= now() - INTERVAL ${days} DAY
    )`);
  }

  if (input.minSessions !== undefined) {
    const min = Math.floor(input.minSessions);
    conditions.push(`id IN (
      SELECT profile_id FROM ${TABLE_NAMES.sessions}
      WHERE project_id = ${pid}
        AND sign = 1
        AND profile_id != ''
      GROUP BY profile_id
      HAVING count() >= ${min}
    )`);
  }

  if (input.performedEvent) {
    conditions.push(`id IN (
      SELECT DISTINCT profile_id FROM ${TABLE_NAMES.eventsRead}
      WHERE project_id = ${pid}
        AND name = ${sqlstring.escape(input.performedEvent)}
    )`);
  }

  const orderDir = input.sortOrder === 'asc' ? 'ASC' : 'DESC';
  const limit = Math.min(input.limit ?? 20, 100);

  const sql = `
    SELECT ${PROFILE_COLUMNS}
    FROM ${TABLE_NAMES.profiles}
    WHERE ${conditions.join(' AND ')}
    ORDER BY created_at ${orderDir}
    LIMIT ${limit}
  `;

  return chQuery<IClickhouseProfile>(sql);
}

export async function getProfileWithEvents(
  projectId: string,
  profileId: string,
  eventLimit = 10
): Promise<{
  profile: IClickhouseProfile | null;
  recent_events: IClickhouseEvent[];
}> {
  const [profiles, recent_events] = await Promise.all([
    chQuery<IClickhouseProfile>(`
      SELECT ${PROFILE_COLUMNS}
      FROM ${TABLE_NAMES.profiles}
      WHERE project_id = ${sqlstring.escape(projectId)} AND id = ${sqlstring.escape(profileId)}
      LIMIT 1
    `),
    clix(ch)
      .select<IClickhouseEvent>([])
      // Newton fork: raw events + alias set-expansion (keeps the profile_id
      // index; the resolved view would full-scan here). See profileIdInClause.
      .from(TABLE_NAMES.events)
      .where('project_id', '=', projectId)
      .rawWhere(profileIdInClause('profile_id', projectId, profileId))
      .orderBy('created_at', 'DESC')
      .limit(eventLimit)
      .execute(),
  ]);

  return { profile: profiles[0] ?? null, recent_events };
}

export function getProfileSessionsCore(
  projectId: string,
  profileId: string,
  limit = 20
): Promise<IClickhouseSession[]> {
  return clix(ch)
    .select<IClickhouseSession>([])
    .from(TABLE_NAMES.sessions)
    .where('project_id', '=', projectId)
    .where('profile_id', '=', profileId)
    .where('sign', '=', 1)
    .orderBy('created_at', 'DESC')
    .limit(limit)
    .execute();
}

export async function getProfileMetricsCore(input: {
  projectId: string;
  profileId: string;
}) {
  const raw = await getProfileMetrics(input.profileId, input.projectId);
  if (!raw) {
    throw new Error(`Profile not found or has no events: ${input.profileId}`);
  }
  return {
    profileId: input.profileId,
    firstSeen: raw.firstSeen,
    lastSeen: raw.lastSeen,
    sessions: raw.sessions,
    screenViews: raw.screenViews,
    totalEvents: raw.totalEvents,
    conversionEvents: raw.conversionEvents,
    uniqueDaysActive: raw.uniqueDaysActive,
    avgSessionDurationMin: raw.durationAvg,
    p90SessionDurationMin: raw.durationP90,
    avgEventsPerSession: raw.avgEventsPerSession,
    avgTimeBetweenSessionsSec: raw.avgTimeBetweenSessions,
    bounceRate: raw.bounceRate,
    revenue: raw.revenue,
  };
}

import sqlstring from 'sqlstring';
import type {
  CohortDefinition,
  EventBasedCohortDefinition,
  EventCriteria,
  Frequency,
  FunnelCohortDefinition,
  IChartEventFilter,
  IReportInput,
  PropertyBasedCohortDefinition,
  Timeframe,
} from '@openpanel/validation';

import type { ClickHouseSettings } from '@clickhouse/client';
import { cohortComputeQueue } from '@openpanel/queue';
import { TABLE_NAMES, ch, chQuery } from '../clickhouse/client';
import { db } from '../prisma-client';
import {
  cohortMembersInClause,
  currentCohortMembersSql,
  RESOLVED_PROFILE_ID_SQL,
} from './profile-resolution';
import { getChartStartEndDate } from './date.service';
import { funnelService } from './funnel.service';
import { getSettingsForProject } from './organization.service';
import { getProfiles, type IServiceProfile } from './profile.service';

// Newton fork: max members materialized into cohort_members per compute,
// env-tunable so it can be raised without an image rebuild (set
// COHORT_MATERIALIZE_LIMIT on the worker and restart). Cohorts larger than
// this are silently truncated to an arbitrary subset — verified live: two
// property cohorts truly have ~77K and ~227K members. Read side and CH are
// comfortable at 1M+; the compute round-trips the member list through the
// worker (~250-300MB heap per 1M members, worker has 8Gi).
export const COHORT_MATERIALIZE_LIMIT = Number.parseInt(
  process.env.COHORT_MATERIALIZE_LIMIT ?? '10000',
  10,
);

// Newton fork: property cohorts aggregate every profile row for the project, so
// they are the one cohort query that can outgrow the server's memory headroom.
// Past this many bytes the GROUP BY writes to disk instead of growing; raising
// it trades headroom for very little time, because the volume spilled is set by
// the data rather than by the threshold (measured on 8.3M profiles: ~281MB
// spilled at a 300MB, 512MB or 768MB threshold, 6.9s/6.7s/6.0s, while peak
// memory climbs 410MiB/695MiB/893MiB). Env-tunable so it can be retuned without
// an image rebuild, same as COHORT_MATERIALIZE_LIMIT.
const COHORT_QUERY_SPILL_BYTES_RAW = Number.parseInt(
  process.env.COHORT_QUERY_SPILL_BYTES ?? '314572800',
  10,
);
const COHORT_QUERY_SPILL_BYTES = Number.isNaN(COHORT_QUERY_SPILL_BYTES_RAW)
  ? 314_572_800
  : COHORT_QUERY_SPILL_BYTES_RAW;

// A GROUP BY only starts spilling once it crosses the threshold, so the hard
// limit has to stay above it — otherwise the query is killed before it ever
// writes to disk. That inversion is exactly what ClickHouse Cloud ships by
// default (a 4GiB threshold against a ceiling reached at 2.4-3.0GiB), and it is
// why nothing spilled before. Derived from the threshold so retuning the env var
// cannot reintroduce it.
const COHORT_QUERY_MEMORY_LIMIT_BYTES = Math.max(
  1_400_000_000,
  COHORT_QUERY_SPILL_BYTES * 3,
);

export const PROFILE_COHORT_QUERY_SETTINGS: ClickHouseSettings = {
  max_bytes_before_external_group_by: String(COHORT_QUERY_SPILL_BYTES),
  max_memory_usage: String(COHORT_QUERY_MEMORY_LIMIT_BYTES),
};

// Newton fork: cohort criteria are evaluated on the RESOLVED identity — the
// raw profile_id folded through the device_alias dictionary, exactly like the
// events_resolved view. This replaces the old identified-only MV gate
// (`profile_id != device_id OR is_external = 1`), which undercounted
// membership two ways: events fired while anonymous were dropped at insert
// and never re-admitted after identify(), and newton-web sends
// device_id == profile_id == uid so real identified users failed both arms.
// Resolution at read is self-healing: a late-discovered alias folds a
// member's pre-login events in at the next scheduled recompute. Membership is
// stored as resolved ids, which is what its consumers already expect
// (cohortMembersInClause re-expands members to their aliases; the all-cohorts
// chart joins against events_resolved profile_ids).
const RESOLVED_PROFILE_ID = RESOLVED_PROFILE_ID_SQL;

function buildTimeConstraint(timeframe: Timeframe): string {
  if (timeframe.type === 'relative') {
    const match = timeframe.value.match(/^(\d+)d$/);
    if (!match) {
      throw new Error(`Invalid relative timeframe: ${timeframe.value}`);
    }
    const days = Number.parseInt(match[1]!, 10);
    return `created_at >= toDate(now() - INTERVAL ${days} DAY)`;
  }

  const start = timeframe.start;
  if (timeframe.end) {
    return `created_at BETWEEN toDate('${start}') AND toDate('${timeframe.end}')`;
  }
  return `created_at >= toDate('${start}')`;
}

function getFrequencyOperator(frequency: Frequency): string {
  switch (frequency.operator) {
    case 'gte':
      return `>= ${frequency.count}`;
    case 'eq':
      return `= ${frequency.count}`;
    case 'lte':
      return `<= ${frequency.count}`;
    default:
      return `>= ${frequency.count}`;
  }
}

export function buildEventCriteriaQuery(
  projectId: string,
  criteria: EventCriteria,
): string {
  const { name, filters, timeframe, frequency } = criteria;
  const timeConstraint = buildTimeConstraint(timeframe);
  const hasEventPropertyFilters = filters.some(
    (f) =>
      f.name.startsWith('properties.') &&
      !f.name.startsWith('profile.properties.'),
  );

  if (hasEventPropertyFilters) {
    const propertyFilters = filters.filter((f) =>
      f.name.startsWith('properties.'),
    );

    const propertyConditions = propertyFilters
      .map((filter) => {
        const propertyKey = filter.name.replace('properties.', '');
        const { value, operator } = filter;

        switch (operator) {
          case 'is':
            if (value.length === 1) {
              return `(property_key = ${sqlstring.escape(propertyKey)} AND property_value = ${sqlstring.escape(String(value[0]).trim())})`;
            }
            return `(property_key = ${sqlstring.escape(propertyKey)} AND property_value IN (${value
              .map((val) => sqlstring.escape(String(val).trim()))
              .join(', ')}))`;
          case 'isNot':
            if (value.length === 1) {
              return `(property_key = ${sqlstring.escape(propertyKey)} AND property_value != ${sqlstring.escape(String(value[0]).trim())})`;
            }
            return `(property_key = ${sqlstring.escape(propertyKey)} AND property_value NOT IN (${value
              .map((val) => sqlstring.escape(String(val).trim()))
              .join(', ')}))`;
          case 'contains':
            return `(property_key = ${sqlstring.escape(propertyKey)} AND (${value
              .map(
                (val) =>
                  `property_value LIKE ${sqlstring.escape(`%${String(val).trim()}%`)}`,
              )
              .join(' OR ')}))`;
          case 'doesNotContain':
            return `(property_key = ${sqlstring.escape(propertyKey)} AND (${value
              .map(
                (val) =>
                  `property_value NOT LIKE ${sqlstring.escape(`%${String(val).trim()}%`)}`,
              )
              .join(' AND ')}))`;
          default:
            return `(property_key = ${sqlstring.escape(propertyKey)} AND property_value IN (${value
              .map((val) => sqlstring.escape(String(val).trim()))
              .join(', ')}))`;
        }
      })
      .join(' OR ');

    if (frequency) {
      const frequencyOp = getFrequencyOperator(frequency);
      return `
        SELECT ${RESOLVED_PROFILE_ID} AS profile_id
        FROM ${TABLE_NAMES.event_property_profile_summary_mv}
        WHERE project_id = ${sqlstring.escape(projectId)}
          AND name = ${sqlstring.escape(name)}
          AND ${timeConstraint.replace('created_at', 'event_date')}
          AND (${propertyConditions})
        GROUP BY profile_id
        HAVING countMerge(event_count) ${frequencyOp}
      `;
    }

    return `
      SELECT DISTINCT ${RESOLVED_PROFILE_ID} AS profile_id
      FROM ${TABLE_NAMES.event_property_profile_summary_mv}
      WHERE project_id = ${sqlstring.escape(projectId)}
        AND name = ${sqlstring.escape(name)}
        AND ${timeConstraint.replace('created_at', 'event_date')}
        AND (${propertyConditions})
    `;
  }

  if (frequency) {
    const frequencyOp = getFrequencyOperator(frequency);
    return `
      SELECT ${RESOLVED_PROFILE_ID} AS profile_id
      FROM ${TABLE_NAMES.event_profile_summary_mv}
      WHERE project_id = ${sqlstring.escape(projectId)}
        AND name = ${sqlstring.escape(name)}
        AND ${timeConstraint.replace('created_at', 'event_date')}
      GROUP BY profile_id
      HAVING countMerge(event_count) ${frequencyOp}
    `;
  }

  return `
    SELECT DISTINCT ${RESOLVED_PROFILE_ID} AS profile_id
    FROM ${TABLE_NAMES.event_profile_summary_mv}
    WHERE project_id = ${sqlstring.escape(projectId)}
      AND name = ${sqlstring.escape(name)}
      AND ${timeConstraint.replace('created_at', 'event_date')}
  `;
}

function buildProfileCohortHavingClause(
  definition: PropertyBasedCohortDefinition,
): string | null {
  const { properties, operator } = definition.criteria;
  const filterWhere = getProfileFiltersWhereClause(properties, {
    latestPerProfile: true,
  });
  const filterClauses = Object.values(filterWhere);

  if (filterClauses.length === 0) {
    return null;
  }

  return filterClauses.join(operator === 'and' ? ' AND ' : ' OR ');
}

export function buildPropertyBasedCohortQuery(
  projectId: string,
  definition: PropertyBasedCohortDefinition,
  limit?: number,
): string {
  const havingClause = buildProfileCohortHavingClause(definition);

  if (!havingClause) {
    return `SELECT id as profile_id FROM ${TABLE_NAMES.profiles} WHERE 1=0`;
  }

  return `
    SELECT id as profile_id
    FROM ${TABLE_NAMES.profiles}
    WHERE project_id = ${sqlstring.escape(projectId)}
    GROUP BY id
    HAVING (${havingClause})
    ${limit ? `LIMIT ${limit}` : ''}
  `;
}

export async function computeEventBasedCohort(
  projectId: string,
  definition: EventBasedCohortDefinition,
  limit?: number,
): Promise<string[]> {
  const { events, operator } = definition.criteria;

  const queries = events.map((eventCriteria) =>
    buildEventCriteriaQuery(projectId, eventCriteria),
  );

  const combinedQuery =
    operator === 'and'
      ? queries.join(' INTERSECT ')
      : queries.join(' UNION DISTINCT ');

  const finalQuery = limit ? `${combinedQuery} LIMIT ${limit}` : combinedQuery;

  const results = await chQuery<{ profile_id: string }>(finalQuery);
  return results.map((r) => r.profile_id);
}

export async function countEventBasedCohort(
  projectId: string,
  definition: EventBasedCohortDefinition,
): Promise<number> {
  const { events, operator } = definition.criteria;

  const queries = events.map((eventCriteria) =>
    buildEventCriteriaQuery(projectId, eventCriteria),
  );

  const combinedQuery =
    operator === 'and'
      ? queries.join(' INTERSECT ')
      : queries.join(' UNION DISTINCT ');

  const countQuery = `SELECT count() as count FROM (${combinedQuery})`;
  const results = await chQuery<{ count: number }>(countQuery);
  return results[0]?.count ?? 0;
}

function getProfileFiltersWhereClause(
  filters: IChartEventFilter[],
  { latestPerProfile = false }: { latestPerProfile?: boolean } = {},
): Record<string, string> {
  const where: Record<string, string> = {};

  filters.forEach((filter, index) => {
    const id = `pf${index}`;
    const { name, value, operator } = filter;

    if (
      value.length === 0 &&
      operator !== 'isNull' &&
      operator !== 'isNotNull'
    ) {
      return;
    }

    const normalizedName = name.replace(/^profile\./, 'profiles.');
    let columnAccess: string;

    if (normalizedName.startsWith('profiles.properties.')) {
      const propKey = normalizedName.replace('profiles.properties.', '');
      columnAccess = `profiles.properties['${propKey}']`;
    } else {
      columnAccess = normalizedName;
    }

    if (latestPerProfile) {
      // Resolve the profile's newest row inside a GROUP BY instead of reading
      // through FINAL. created_at is the table's version column but it is not
      // unique — duplicate rows routinely share one — so it is paired with the
      // value itself to break ties deterministically. FINAL breaks the same
      // ties by part order, which is not derivable from the data and can shift
      // under a background merge.
      columnAccess = `argMax(${columnAccess}, tuple(created_at, ${columnAccess}))`;
    }

    switch (operator) {
      case 'is': {
        if (value.length === 1) {
          where[id] = `${columnAccess} = ${sqlstring.escape(String(value[0]).trim())}`;
        } else {
          where[id] = `${columnAccess} IN (${value
            .map((val) => sqlstring.escape(String(val).trim()))
            .join(', ')})`;
        }
        break;
      }
      case 'isNot': {
        if (value.length === 1) {
          where[id] = `${columnAccess} != ${sqlstring.escape(String(value[0]).trim())}`;
        } else {
          where[id] = `${columnAccess} NOT IN (${value
            .map((val) => sqlstring.escape(String(val).trim()))
            .join(', ')})`;
        }
        break;
      }
      case 'contains': {
        where[id] = `(${value
          .map(
            (val) =>
              `${columnAccess} LIKE ${sqlstring.escape(`%${String(val).trim()}%`)}`,
          )
          .join(' OR ')})`;
        break;
      }
      case 'doesNotContain': {
        where[id] = `(${value
          .map(
            (val) =>
              `${columnAccess} NOT LIKE ${sqlstring.escape(`%${String(val).trim()}%`)}`,
          )
          .join(' OR ')})`;
        break;
      }
      case 'startsWith': {
        where[id] = `(${value
          .map(
            (val) =>
              `${columnAccess} LIKE ${sqlstring.escape(`${String(val).trim()}%`)}`,
          )
          .join(' OR ')})`;
        break;
      }
      case 'endsWith': {
        where[id] = `(${value
          .map(
            (val) =>
              `${columnAccess} LIKE ${sqlstring.escape(`%${String(val).trim()}`)}`,
          )
          .join(' OR ')})`;
        break;
      }
      case 'isNull': {
        where[id] = `(${columnAccess} IS NULL OR ${columnAccess} = '')`;
        break;
      }
      case 'isNotNull': {
        where[id] = `(${columnAccess} IS NOT NULL AND ${columnAccess} != '')`;
        break;
      }
      case 'gt': {
        if (value[0] !== undefined) {
          where[id] = `toFloat64OrNull(${columnAccess}) > ${Number(value[0])}`;
        }
        break;
      }
      case 'lt': {
        if (value[0] !== undefined) {
          where[id] = `toFloat64OrNull(${columnAccess}) < ${Number(value[0])}`;
        }
        break;
      }
      case 'gte': {
        if (value[0] !== undefined) {
          where[id] = `toFloat64OrNull(${columnAccess}) >= ${Number(value[0])}`;
        }
        break;
      }
      case 'lte': {
        if (value[0] !== undefined) {
          where[id] = `toFloat64OrNull(${columnAccess}) <= ${Number(value[0])}`;
        }
        break;
      }
    }
  });

  return where;
}

export async function computePropertyBasedCohort(
  projectId: string,
  definition: PropertyBasedCohortDefinition,
  limit?: number,
): Promise<string[]> {
  if (!buildProfileCohortHavingClause(definition)) {
    return [];
  }

  const results = await chQuery<{ profile_id: string }>(
    buildPropertyBasedCohortQuery(projectId, definition, limit),
    PROFILE_COHORT_QUERY_SETTINGS,
  );
  return results.map((r) => r.profile_id);
}

export async function countPropertyBasedCohort(
  projectId: string,
  definition: PropertyBasedCohortDefinition,
): Promise<number> {
  if (!buildProfileCohortHavingClause(definition)) {
    return 0;
  }

  const results = await chQuery<{ count: number }>(
    `SELECT count() as count FROM (${buildPropertyBasedCohortQuery(projectId, definition)})`,
    PROFILE_COHORT_QUERY_SETTINGS,
  );
  return results[0]?.count ?? 0;
}

export async function storeCohortMembership(
  projectId: string,
  cohortId: string,
  profileIds: string[],
  version: number,
): Promise<void> {
  const now = new Date().toISOString().slice(0, 19).replace('T', ' ');

  if (profileIds.length > 0) {
    const data = profileIds.map((profileId) => ({
      project_id: projectId,
      cohort_id: cohortId,
      profile_id: profileId,
      matched_at: now,
      matching_properties: {},
      version,
    }));

    await ch.insert({
      table: TABLE_NAMES.cohort_members,
      values: data,
      format: 'JSONEachRow',
    });
  }

  const sampleProfiles = profileIds.slice(0, 10);
  await ch.insert({
    table: TABLE_NAMES.cohort_metadata,
    values: [
      {
        project_id: projectId,
        cohort_id: cohortId,
        member_count: profileIds.length,
        last_computed_at: now,
        sample_profiles: sampleProfiles,
        version,
      },
    ],
    format: 'JSONEachRow',
  });
}

export async function getCohortMembers(
  cohortId: string,
  projectId: string,
  opts?: { limit?: number; offset?: number },
): Promise<{ profileIds: string[]; total: number }> {
  const cohort = await db.cohort.findUnique({ where: { id: cohortId } });

  if (!cohort) {
    throw new Error('Cohort not found');
  }

  const query = `
    SELECT
      profile_id,
      count() OVER() as total
    FROM ${TABLE_NAMES.cohort_members} FINAL
    WHERE project_id = ${sqlstring.escape(projectId)}
      AND cohort_id = ${sqlstring.escape(cohortId)}
      AND version = (
        SELECT max(version) FROM ${TABLE_NAMES.cohort_members} FINAL
        WHERE project_id = ${sqlstring.escape(projectId)} AND cohort_id = ${sqlstring.escape(cohortId)}
      )
    ORDER BY matched_at DESC
    ${opts?.limit ? `LIMIT ${opts.limit}` : ''}
    ${opts?.offset ? `OFFSET ${opts.offset}` : ''}
  `;

  const results = await chQuery<{ profile_id: string; total: number }>(query);
  return {
    profileIds: results.map((r) => r.profile_id),
    total: results[0]?.total || 0,
  };
}

export async function getCohortCount(
  cohortId: string,
  projectId: string,
): Promise<number> {
  const cohort = await db.cohort.findUnique({ where: { id: cohortId } });

  if (!cohort) {
    throw new Error('Cohort not found');
  }

  if (cohort.lastComputedAt) {
    const age = Date.now() - cohort.lastComputedAt.getTime();
    if (age < 15 * 60 * 1000) {
      return cohort.profileCount;
    }
  }

  const result = await chQuery<{ count: number }>(`
    SELECT count() as count
    FROM (${currentCohortMembersSql(projectId, cohortId)})
  `);
  return result[0]?.count || 0;
}

/**
 * Funnel cohorts reuse the exact query behind the funnel report's View Users
 * modal, so the cohort holds the same users the chart shows for that step.
 * A relative range is re-anchored to now on every compute.
 */
export async function computeFunnelCohort(
  projectId: string,
  definition: FunnelCohortDefinition,
  limit?: number,
): Promise<string[]> {
  const { criteria } = definition;
  const { timezone } = await getSettingsForProject(projectId);
  const { startDate, endDate } = getChartStartEndDate(
    {
      startDate: criteria.startDate ?? null,
      endDate: criteria.endDate ?? null,
      range: criteria.range as IReportInput['range'],
    },
    timezone,
  );
  // The stored series is a trimmed mirror of the report series schema; the
  // funnel builder only reads name/filters (and id for step lookup).
  const series = criteria.series.map((s) => ({
    ...s,
    segment: (s.segment ?? 'event') as 'event',
    filters: s.filters ?? [],
  })) as IReportInput['series'];

  return funnelService.getFunnelProfileIds({
    projectId,
    startDate,
    endDate,
    series,
    stepIndex: criteria.stepIndex,
    showDropoffs: criteria.showDropoffs,
    breakdowns: criteria.breakdowns,
    breakdownValues: criteria.breakdownValues,
    funnelWindow: criteria.funnelWindow,
    funnelGroup: criteria.funnelGroup,
    timezone,
    limit,
  });
}

export async function computeCohort(
  projectId: string,
  definition: CohortDefinition,
  limit?: number,
): Promise<string[]> {
  if (definition.type === 'event') {
    return computeEventBasedCohort(projectId, definition, limit);
  }
  if (definition.type === 'property') {
    return computePropertyBasedCohort(projectId, definition, limit);
  }
  if (definition.type === 'funnel') {
    return computeFunnelCohort(projectId, definition, limit);
  }
  return [];
}

export async function countCohort(
  projectId: string,
  definition: CohortDefinition,
): Promise<number> {
  if (definition.type === 'event') {
    return countEventBasedCohort(projectId, definition);
  }
  if (definition.type === 'property') {
    return countPropertyBasedCohort(projectId, definition);
  }
  if (definition.type === 'funnel') {
    // Same cap as materialization; the funnel query has no count variant.
    const ids = await computeFunnelCohort(
      projectId,
      definition,
      COHORT_MATERIALIZE_LIMIT,
    );
    return ids.length;
  }
  return 0;
}

export async function updateCohortMembership(
  cohortId: string,
): Promise<void> {
  const cohort = await db.cohort.findUnique({ where: { id: cohortId } });

  if (!cohort) {
    return;
  }

  const definition = cohort.definition as CohortDefinition;
  const profileIds = await computeCohort(
    cohort.projectId,
    definition,
    COHORT_MATERIALIZE_LIMIT,
  );

  const version = Date.now();

  await storeCohortMembership(
    cohort.projectId,
    cohort.id,
    profileIds,
    version,
  );

  await db.cohort.update({
    where: { id: cohortId },
    data: {
      profileCount: profileIds.length,
      lastComputedAt: new Date(),
    },
  });
}

export async function deleteCohortMembership(
  cohortId: string,
  projectId: string,
): Promise<void> {
  await ch.command({
    query: `ALTER TABLE ${TABLE_NAMES.cohort_members} DELETE WHERE cohort_id = ${sqlstring.escape(cohortId)} AND project_id = ${sqlstring.escape(projectId)}`,
  });
  await ch.command({
    query: `ALTER TABLE ${TABLE_NAMES.cohort_metadata} DELETE WHERE cohort_id = ${sqlstring.escape(cohortId)} AND project_id = ${sqlstring.escape(projectId)}`,
  });
}

export async function getProfilesInCohort(
  cohortId: string,
  projectId: string,
): Promise<Set<string>> {
  const { profileIds } = await getCohortMembers(cohortId, projectId, {
    limit: 100000,
  });
  return new Set(profileIds);
}

export async function enqueueCohortCompute(cohortId: string): Promise<void> {
  await cohortComputeQueue.add(
    'cohortCompute',
    { cohortId },
    {
      // Deduplicate on the cohort rather than pinning a fixed jobId. A fixed
      // jobId also gates on the *finished* job's record, which bullmq only
      // deletes lazily from inside another job's completion — so once every
      // cohort held a finished record, no add could ever land again and the 30
      // minute cohortRefresh cron went silent permanently. Without a ttl the
      // deduplication key is released when the job is completed *or* failed, so
      // it only ever collapses a compute that is genuinely still in flight.
      deduplication: { id: `cohort-${cohortId}` },
      removeOnComplete: { age: 3600, count: 100 },
      removeOnFail: { age: 86400 },
    },
  );
}

export async function listCohortMemberProfiles({
  projectId,
  cohortId,
  cursor,
  take,
  search,
}: {
  projectId: string;
  cohortId: string;
  cursor?: number;
  take: number;
  search?: string;
}): Promise<{ data: IServiceProfile[]; count: number }> {
  const offset = Math.max(0, (cursor ?? 0) * take);
  const trimmed = search?.trim();
  const searchCondition = trimmed
    ? `AND (email ILIKE ${sqlstring.escape(`%${trimmed}%`)} OR first_name ILIKE ${sqlstring.escape(`%${trimmed}%`)} OR last_name ILIKE ${sqlstring.escape(`%${trimmed}%`)})`
    : '';

  const rows = await chQuery<{ id: string; total_count: number }>(`
    SELECT id, count() OVER () AS total_count
    FROM ${TABLE_NAMES.profiles} FINAL
    WHERE project_id = ${sqlstring.escape(projectId)}
      AND id IN (${currentCohortMembersSql(projectId, cohortId)})
      ${searchCondition}
    ORDER BY created_at DESC
    LIMIT ${take} OFFSET ${offset}
  `);

  const count = rows[0]?.total_count ?? 0;
  const ids = rows.map((r) => r.id);
  if (ids.length === 0) return { data: [], count };

  const profiles = await getProfiles(ids, projectId);
  const byId = new Map(profiles.map((p) => [p.id, p]));
  const data = ids
    .map((id) => byId.get(id))
    .filter(Boolean) as IServiceProfile[];
  return { data, count };
}

export async function getCohortMemberEvents(
  projectId: string,
  cohortId: string,
  limit = 10,
): Promise<{ name: string; count: number }[]> {
  // Newton fork: raw events + cohort alias set-expansion. Filtering the resolved
  // view by `profile_id IN (...)` defeats the profile_id index and full-scans the
  // table (unbounded here). cohortMembersInClause matches members + their cookie
  // aliases on raw events, so members' anonymous events are still counted.
  return chQuery<{ name: string; count: number }>(`
    SELECT name, count() AS count
    FROM ${TABLE_NAMES.events}
    WHERE project_id = ${sqlstring.escape(projectId)}
      AND ${cohortMembersInClause('profile_id', projectId, cohortId)}
      AND name NOT IN ('screen_view', 'session_start', 'session_end')
    GROUP BY name
    ORDER BY count DESC
    LIMIT ${limit}
  `);
}

export async function getCohortEventsPerDay(
  projectId: string,
  cohortId: string,
  days = 30,
): Promise<{ date: string; count: number }[]> {
  const rows = await chQuery<{ date: string; count: number }>(`
    SELECT
      toDate(created_at) AS date,
      count() AS count
    FROM ${TABLE_NAMES.events}
    WHERE project_id = ${sqlstring.escape(projectId)}
      AND created_at >= toDate(now() - INTERVAL ${days} DAY)
      AND ${cohortMembersInClause('profile_id', projectId, cohortId)}
    GROUP BY date
    ORDER BY date ASC
    WITH FILL
      FROM toDate(now() - INTERVAL ${days} DAY)
      TO toDate(now() + INTERVAL 1 DAY)
      STEP INTERVAL 1 DAY
  `);
  return rows.map((r) => ({ date: String(r.date), count: Number(r.count) }));
}

export async function getCohortMemberRoutes(
  projectId: string,
  cohortId: string,
  limit = 10,
): Promise<{ path: string; count: number }[]> {
  return chQuery<{ path: string; count: number }>(`
    SELECT path, count() AS count
    FROM ${TABLE_NAMES.events}
    WHERE project_id = ${sqlstring.escape(projectId)}
      AND ${cohortMembersInClause('profile_id', projectId, cohortId)}
      AND name = 'screen_view'
      AND path != ''
    GROUP BY path
    ORDER BY count DESC
    LIMIT ${limit}
  `);
}

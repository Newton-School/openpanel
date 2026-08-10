import { ifNaN } from '@openpanel/common';
import type { IChartEvent, IReportInput } from '@openpanel/validation';
import { last, reverse, uniq } from 'ramda';
import sqlstring from 'sqlstring';
import { ch } from '../clickhouse/client';
import { TABLE_NAMES } from '../clickhouse/client';
import { clix } from '../clickhouse/query-builder';
import { createSqlBuilder } from '../sql-builder';
import {
  buildInlineCohortJoin,
  collectCohortIds,
  collectProfilePropertyKeys,
  extractCohortId,
  fetchCohortsMetadata,
  getEventFiltersWhereClause,
  getSelectPropertyKey,
  profilePropertiesCteSelect,
  rewriteProfilePropertyRefs,
} from './chart.service';
import { onlyReportEvents } from './reports.service';

/** Display label for null/empty breakdown values (e.g. property not set). */
export const EMPTY_BREAKDOWN_LABEL = 'Not set';

function normalizeBreakdownValue(value: unknown): string {
  if (value == null || value === '') {
    return EMPTY_BREAKDOWN_LABEL;
  }
  const s = String(value).trim();
  return s === '' ? EMPTY_BREAKDOWN_LABEL : s;
}

export class FunnelService {
  constructor(private client: typeof ch) {}

  /**
   * Returns the grouping strategy for the funnel.
   * Determines whether windowFunnel is computed per session_id or profile_id.
   */
  getFunnelGroup(group?: string): 'profile_id' | 'session_id' {
    return group === 'profile_id' ? 'profile_id' : 'session_id';
  }

  getFunnelConditions(events: IChartEvent[] = [], projectId?: string): string[] {
    return events.map((event) => {
      const { sb, getWhere } = createSqlBuilder();
      sb.where = getEventFiltersWhereClause(event.filters, projectId);
      sb.where.name = `events.name = ${sqlstring.escape(event.name)}`;
      return getWhere().replace('WHERE ', '');
    });
  }

  /**
   * Builds the funnel CTE.
   * - When group === 'session_id': windowFunnel is computed per session_id.
   *   profile_id is resolved via argMax to handle identity changes mid-session.
   * - When group === 'profile_id': windowFunnel is computed directly per profile_id.
   *   This correctly handles cross-session funnel completions.
   */
  buildFunnelCte({
    projectId,
    startDate,
    endDate,
    eventSeries,
    funnelWindowMilliseconds,
    timezone,
    additionalSelects = [],
    additionalGroupBy = [],
    group = 'session_id',
    profilePropertyKeys = [],
  }: {
    projectId: string;
    startDate: string;
    endDate: string;
    eventSeries: IChartEvent[];
    funnelWindowMilliseconds: number;
    timezone: string;
    additionalSelects?: string[];
    additionalGroupBy?: string[];
    group?: 'session_id' | 'profile_id';
    profilePropertyKeys?: string[];
  }) {
    const funnels = this.getFunnelConditions(eventSeries, projectId).map((c) =>
      rewriteProfilePropertyRefs(c, profilePropertyKeys),
    );
    const primaryKey = group === 'profile_id' ? 'profile_id' : 'session_id';
    // Newton fork: match Mixpanel's default (non-strict) funnel ordering — consecutive
    // steps require created_at >= prev, not strictly >. OP events carry distinct ms
    // timestamps so this is largely a no-op on real data, but it aligns with MP for any
    // same-timestamp/burst sequences. Set NEWTON_FUNNEL_STRICT_INCREASE=1 to restore strict.
    const windowFunnelMode =
      process.env.NEWTON_FUNNEL_STRICT_INCREASE === '1' ? ", 'strict_increase'" : '';

    return clix(this.client, timezone)
      .select([
        primaryKey,
        `windowFunnel(${funnelWindowMilliseconds}${windowFunnelMode})(toUInt64(toUnixTimestamp64Milli(created_at)), ${funnels.join(', ')}) AS level`,
        ...(group === 'session_id'
          ? ['argMax(profile_id, created_at) AS profile_id']
          : []),
        ...additionalSelects,
      ])
      // Newton fork: read from the resolution view so anonymous (pre-login)
      // events fold into the identified profile for funnel grouping. Inert
      // unless NEWTON_RESOLVE_PROFILE=1 (eventsRead === events otherwise).
      // Must keep the `events` alias: funnel conditions, the name filter and
      // the profile/cohort joins all qualify columns as `events.*`.
      .from(`${TABLE_NAMES.eventsRead} AS events`, false)
      .where('project_id', '=', projectId)
      .where('created_at', 'BETWEEN', [
        clix.datetime(startDate, 'toDateTime'),
        clix.datetime(endDate, 'toDateTime'),
      ])
      .where(
        'events.name',
        'IN',
        eventSeries.map((e) => e.name),
      )
      .rawWhere(`(${funnels.map((f) => `(${f})`).join(' OR ')})`)
      .groupBy([primaryKey, ...additionalGroupBy]);
  }

  buildSessionsCte({
    projectId,
    startDate,
    endDate,
    timezone,
  }: {
    projectId: string;
    startDate: string;
    endDate: string;
    timezone: string;
  }) {
    return clix(this.client, timezone)
      .select(['profile_id as pid', 'id as sid'])
      .from(TABLE_NAMES.sessions)
      .where('project_id', '=', projectId)
      .where('created_at', 'BETWEEN', [
        clix.datetime(startDate, 'toDateTime'),
        clix.datetime(endDate, 'toDateTime'),
      ]);
  }

  private fillFunnel(
    funnel: { level: number; count: number }[],
    steps: number,
  ) {
    const filled = Array.from({ length: steps }, (_, index) => {
      const level = index + 1;
      const matchingResult = funnel.find((res) => res.level === level);
      return {
        level,
        count: matchingResult ? matchingResult.count : 0,
      };
    });

    // Accumulate counts from top to bottom of the funnel
    for (let i = filled.length - 1; i >= 0; i--) {
      const step = filled[i];
      const prevStep = filled[i + 1];
      // If there's a previous step, add the count to the current step
      if (step && prevStep) {
        step.count += prevStep.count;
      }
    }
    return filled.reverse();
  }

  toSeries(
    funnel: { level: number; count: number; [key: string]: any }[],
    breakdowns: { name: string }[] = [],
    limit: number | undefined = undefined,
  ) {
    if (!breakdowns.length) {
      return [
        funnel.map((f) => ({
          level: f.level,
          count: f.count,
          id: 'none',
          breakdowns: [],
        })),
      ];
    }

    // Group by breakdown values (normalize empty/null to "Not set")
    const series = funnel.reduce(
      (acc, f) => {
        if (limit && Object.keys(acc).length >= limit) {
          return acc;
        }

        const key = breakdowns
          .map((b, index) => normalizeBreakdownValue(f[`b_${index}`]))
          .join('|');
        if (!acc[key]) {
          acc[key] = [];
        }
        acc[key]!.push({
          id: key,
          breakdowns: breakdowns.map((b, index) =>
            normalizeBreakdownValue(f[`b_${index}`]),
          ),
          level: f.level,
          count: f.count,
        });
        return acc;
      },
      {} as Record<
        string,
        {
          id: string;
          breakdowns: string[];
          level: number;
          count: number;
        }[]
      >,
    );

    return Object.values(series);
  }

  getProfileFilters(events: IChartEvent[]) {
    return events.flatMap((e) =>
      e.filters
        ?.filter((f) => f.name.startsWith('profile.'))
        .map((f) => f.name.replace('profile.', '')),
    );
  }

  /**
   * Builds the funnel query up to and including the `funnel` CTE.
   * Shared by getFunnel (the chart) and buildFunnelProfileIdsQuery (the
   * "View Users" modal) so both always evaluate the exact same funnel:
   * same breakdown attribution (argMinIf at the entry step), same
   * profile/cohort/group joins. Any divergence between the two shows up
   * as "chart says N users, modal says none" (NS-13549).
   */
  async buildFunnelQuery({
    projectId,
    startDate,
    endDate,
    eventSeries,
    breakdowns = [],
    funnelWindowMilliseconds,
    funnelGroup,
    timezone,
  }: {
    projectId: string;
    startDate: string;
    endDate: string;
    eventSeries: IChartEvent[];
    breakdowns: { name: string }[];
    funnelWindowMilliseconds: number;
    funnelGroup?: string;
    timezone: string;
  }) {
    const group = this.getFunnelGroup(funnelGroup);
    const profileFilters = this.getProfileFilters(eventSeries);
    const anyFilterOnProfile = profileFilters.length > 0;
    const anyBreakdownOnProfile = breakdowns.some((b) =>
      b.name.startsWith('profile.'),
    );
    const anyFilterOnGroup = eventSeries.some((e) =>
      e.filters?.some((f) => f.name.startsWith('group.')),
    );
    const anyBreakdownOnGroup = breakdowns.some((b) =>
      b.name.startsWith('group.'),
    );
    const needsGroupArrayJoin =
      anyFilterOnGroup || anyBreakdownOnGroup || funnelGroup === 'group';

    const allFilters = eventSeries.flatMap((e) => e.filters ?? []);
    const cohortIds = collectCohortIds(allFilters, breakdowns);
    const cohortMetadata = await fetchCohortsMetadata(cohortIds);

    // Newton fork: join only the referenced profile-property keys as scalar
    // columns instead of every profile's whole properties Map (multi-GiB on the
    // events×profiles join — same fix as the chart profile CTE). References in
    // funnel conditions/breakdowns are rewritten to the scalar aliases below.
    const profileProps = collectProfilePropertyKeys([
      ...allFilters,
      ...breakdowns,
    ]);

    // Create the funnel CTE (session-level)
    //
    // Newton fork: attribute each breakdown to the value at the FIRST funnel
    // step, as a per-group aggregate (argMinIf) — do NOT add it to the
    // windowFunnel GROUP BY. Grouping the sequence by a per-row property splits
    // a user's steps across buckets whenever the property isn't identical on
    // every step (e.g. an experiment `cohort` set on `experiment_started` but
    // absent on `paid`): the later step lands in a separate (empty) bucket, the
    // windowFunnel sequence never connects, and downstream steps show 0. Reading
    // the entry-step value keeps each user's sequence intact in one group and
    // matches standard funnel-breakdown semantics (segment by entry attribute).
    const funnelConditions = this.getFunnelConditions(
      eventSeries,
      projectId,
    ).map((c) => rewriteProfilePropertyRefs(c, profileProps.keys));
    const firstStepCondition = funnelConditions[0]!;
    const breakdownSelects = breakdowns.map((b, index) => {
      const bId = extractCohortId(b.name);
      const bName = bId ? cohortMetadata.get(bId)?.name : undefined;
      const expr = rewriteProfilePropertyRefs(
        getSelectPropertyKey(b.name, projectId, bId ?? undefined, bName),
        profileProps.keys,
      );
      return `argMinIf(${expr}, created_at, ${firstStepCondition}) as b_${index}`;
    });

    const funnelCte = this.buildFunnelCte({
      projectId,
      startDate,
      endDate,
      eventSeries,
      funnelWindowMilliseconds,
      timezone,
      additionalSelects: breakdownSelects,
      group,
      profilePropertyKeys: profileProps.keys,
    });

    if (anyFilterOnProfile || anyBreakdownOnProfile) {
      // Collect profile columns needed for filters and breakdowns. Scalar
      // columns (email etc.) are selected as-is; the properties Map is narrowed
      // to the referenced keys via profilePropertiesCteSelect — joining the
      // whole Map of every profile costs multi-GiB per funnel.
      const profileFields = new Set<string>(['id']);
      for (const f of profileFilters) {
        const fieldName = f.split('.')[0]!;
        if (fieldName !== 'properties') {
          profileFields.add(fieldName);
        }
      }
      for (const b of breakdowns.filter((x) => x.name.startsWith('profile.'))) {
        const fieldName = b.name.replace('profile.', '').split('.')[0];
        if (['email', 'first_name', 'last_name'].includes(fieldName!)) {
          profileFields.add(fieldName!);
        }
      }
      const selectColumns = Array.from(profileFields);
      const referencesProperties =
        profileFilters.some((f) => f.startsWith('properties')) ||
        breakdowns.some((b) => b.name.startsWith('profile.properties'));
      if (referencesProperties) {
        selectColumns.push(
          profilePropertiesCteSelect(profileProps.keys, profileProps.hasWildcard),
        );
      }
      funnelCte.leftJoin(
        `(SELECT ${selectColumns.join(', ')} FROM ${TABLE_NAMES.profiles} FINAL
          WHERE project_id = ${sqlstring.escape(projectId)}) as profile`,
        'profile.id = events.profile_id',
      );
    }

    if (needsGroupArrayJoin) {
      funnelCte.rawJoin('ARRAY JOIN groups AS _group_id');
      funnelCte.rawJoin('LEFT ANY JOIN _g ON _g.id = _group_id');
    }

    for (const cohortId of cohortIds) {
      funnelCte.rawJoin(buildInlineCohortJoin(cohortId, projectId, 'events'));
    }

    // Base funnel query with CTEs
    const funnelQuery = clix(this.client, timezone);

    if (needsGroupArrayJoin) {
      funnelQuery.with(
        '_g',
        `SELECT id, name, type, properties FROM ${TABLE_NAMES.groups} FINAL WHERE project_id = ${sqlstring.escape(projectId)}`,
      );
    }

    funnelQuery.with('session_funnel', funnelCte);

    // windowFunnel is computed per the primary key (profile_id or session_id),
    // so we just filter out level=0 rows — no re-aggregation needed.
    funnelQuery.with(
      'funnel',
      'SELECT * FROM session_funnel WHERE level != 0',
    );

    return funnelQuery;
  }

  async getFunnel({
    projectId,
    startDate,
    endDate,
    series,
    options,
    breakdowns = [],
    limit,
    timezone = 'UTC',
  }: IReportInput & { timezone: string; events?: IChartEvent[] }) {
    if (!startDate || !endDate) {
      throw new Error('startDate and endDate are required');
    }

    const funnelOptions = options?.type === 'funnel' ? options : undefined;
    const funnelWindow = funnelOptions?.funnelWindow ?? 24;
    const funnelGroup = funnelOptions?.funnelGroup;

    const eventSeries = onlyReportEvents(series);

    if (eventSeries.length === 0) {
      throw new Error('events are required');
    }

    const funnelQuery = await this.buildFunnelQuery({
      projectId,
      startDate,
      endDate,
      eventSeries,
      breakdowns,
      funnelWindowMilliseconds: funnelWindow * 3600 * 1000,
      funnelGroup,
      timezone,
    });

    funnelQuery
      .select<{
        level: number;
        count: number;
        [key: string]: any;
      }>([
        'level',
        ...breakdowns.map((b, index) => `b_${index}`),
        'count() as count',
      ])
      .from('funnel')
      .groupBy(['level', ...breakdowns.map((b, index) => `b_${index}`)])
      .orderBy('level', 'DESC');

    const funnelData = await funnelQuery.execute();
    const funnelSeries = this.toSeries(funnelData, breakdowns, limit);

    return funnelSeries
      .map((data) => {
        const maxLevel = eventSeries.length;
        const filledFunnelRes = this.fillFunnel(
          data.map((d) => ({ level: d.level, count: d.count })),
          maxLevel,
        );

        const totalSessions = last(filledFunnelRes)?.count ?? 0;
        const steps = reverse(filledFunnelRes)
          .reduce(
            (acc, item, index, list) => {
              const prev = list[index - 1] ?? { count: totalSessions };
              const next = list[index + 1];
              const event = eventSeries[item.level - 1]!;
              return [
                ...acc,
                {
                  event: {
                    ...event,
                    displayName: event.displayName || event.name,
                  },
                  count: item.count,
                  percent: (item.count / totalSessions) * 100,
                  dropoffCount: next ? item.count - next.count : null,
                  dropoffPercent: next
                    ? ((item.count - next.count) / item.count) * 100
                    : null,
                  previousCount: prev.count,
                  nextCount: next?.count ?? null,
                },
              ];
            },
            [] as {
              event: IChartEvent & { displayName: string };
              count: number;
              percent: number;
              dropoffCount: number | null;
              dropoffPercent: number | null;
              previousCount: number;
              nextCount: number | null;
            }[],
          )
          .map((step, index, list) => {
            return {
              ...step,
              percent: ifNaN(step.percent, 0),
              dropoffPercent: ifNaN(step.dropoffPercent, 0),
              isHighestDropoff: (() => {
                // Skip if current step has no dropoff
                if (!step?.dropoffCount) return false;

                // Get maximum dropoff count, excluding 0s
                const maxDropoff = Math.max(
                  ...list
                    .map((s) => s.dropoffCount || 0)
                    .filter((count) => count > 0),
                );

                // Check if this is the first step with the highest dropoff
                return (
                  step.dropoffCount === maxDropoff &&
                  list.findIndex((s) => s.dropoffCount === maxDropoff) === index
                );
              })(),
            };
          });

        return {
          id: data[0]?.id ?? 'none',
          breakdowns: data[0]?.breakdowns ?? [],
          steps,
          totalSessions,
          lastStep: last(steps)!,
          mostDropoffsStep: steps.find((step) => step.isHighestDropoff)!,
        };
      })
      .sort((a, b) => {
        const aTotal = a.steps.reduce((acc, step) => acc + step.count, 0);
        const bTotal = b.steps.reduce((acc, step) => acc + step.count, 0);
        return bTotal - aTotal;
      });
  }

  /**
   * Query for the profile ids behind a funnel step ("View Users" modal).
   * stepIndex is 0-based; completed = level >= step, dropped = level == step.
   * The clicked breakdown row passes back the DISPLAY labels (trimmed,
   * empty → EMPTY_BREAKDOWN_LABEL via normalizeBreakdownValue), so values
   * are matched against the same normalization, not the raw column.
   */
  async buildFunnelProfileIdsQuery({
    projectId,
    startDate,
    endDate,
    series,
    stepIndex,
    showDropoffs = false,
    breakdowns = [],
    breakdownValues = [],
    funnelWindow,
    funnelGroup,
    timezone,
    limit = 1000,
  }: {
    projectId: string;
    startDate: string;
    endDate: string;
    series: IReportInput['series'];
    stepIndex: number;
    showDropoffs?: boolean;
    breakdowns?: { name: string }[];
    breakdownValues?: string[];
    funnelWindow?: number;
    funnelGroup?: string;
    timezone: string;
    limit?: number;
  }) {
    const eventSeries = onlyReportEvents(series);

    if (eventSeries.length === 0) {
      throw new Error('At least one event series is required');
    }

    const funnelQuery = await this.buildFunnelQuery({
      projectId,
      startDate,
      endDate,
      eventSeries,
      breakdowns,
      funnelWindowMilliseconds: (funnelWindow ?? 24) * 3600 * 1000,
      funnelGroup,
      timezone,
    });

    const targetLevel = stepIndex + 1;

    funnelQuery
      .select<{ profile_id: string }>(['DISTINCT profile_id'])
      .from('funnel')
      .where('level', showDropoffs ? '=' : '>=', targetLevel);

    breakdowns.forEach((_, index) => {
      const value = breakdownValues[index];
      if (value === undefined) {
        return;
      }
      if (value === EMPTY_BREAKDOWN_LABEL) {
        funnelQuery.rawWhere(
          `(trim(b_${index}) = '' OR trim(b_${index}) = ${sqlstring.escape(EMPTY_BREAKDOWN_LABEL)})`,
        );
      } else {
        funnelQuery.rawWhere(
          `trim(b_${index}) = ${sqlstring.escape(value)}`,
        );
      }
    });

    // Cap the number of profiles to avoid exceeding ClickHouse
    // max_query_size when passing the ids to the profiles lookup.
    funnelQuery.limit(limit);

    return funnelQuery;
  }

  async getFunnelProfileIds(
    input: Parameters<FunnelService['buildFunnelProfileIdsQuery']>[0],
  ): Promise<string[]> {
    const query = await this.buildFunnelProfileIdsQuery(input);
    const rows = await query.execute();
    return rows.map((row) => row.profile_id).filter(Boolean);
  }
}

export const funnelService = new FunnelService(ch);

import { getSettingsForProject } from './organization.service';

export async function getFunnelCore(input: {
  projectId: string;
  startDate: string;
  endDate: string;
  steps: string[];
  windowHours?: number;
  groupBy?: 'session_id' | 'profile_id';
}) {
  const { timezone } = await getSettingsForProject(input.projectId);
  const eventSeries = input.steps.map((name, index) => ({
    id: String(index + 1),
    type: 'event' as const,
    name,
    displayName: name,
    segment: 'user' as const,
    filters: [],
  }));

  const result = await funnelService.getFunnel({
    projectId: input.projectId,
    startDate: input.startDate,
    endDate: input.endDate,
    series: eventSeries,
    breakdowns: [],
    chartType: 'funnel',
    interval: 'day',
    range: 'custom',
    previous: false,
    metric: 'sum',
    options: {
      type: 'funnel',
      funnelWindow: input.windowHours ?? 24,
      funnelGroup: input.groupBy ?? 'session_id',
    },
    timezone,
  });

  const primarySeries = result[0];
  if (!primarySeries) {
    return {
      steps: [],
      totalUsers: 0,
      completedUsers: 0,
      overallConversionRate: 0,
    };
  }

  const steps = primarySeries.steps.map((step, index) => ({
    step: index + 1,
    eventName: step.event.displayName || step.event.name,
    users: step.count,
    conversionRateFromStart: Math.round(step.percent * 100) / 100,
    dropoffPercent:
      step.dropoffPercent != null
        ? Math.round(step.dropoffPercent * 100) / 100
        : null,
    isHighestDropoff: step.isHighestDropoff,
  }));

  const totalUsers = steps[0]?.users ?? 0;
  const completedUsers = steps[steps.length - 1]?.users ?? 0;

  return {
    steps,
    totalUsers,
    completedUsers,
    overallConversionRate:
      totalUsers > 0
        ? Math.round((completedUsers / totalUsers) * 10000) / 100
        : 0,
  };
}

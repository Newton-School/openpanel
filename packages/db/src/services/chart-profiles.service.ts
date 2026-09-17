import type { IChartEvent, IInterval } from '@openpanel/validation';
import { uniq } from 'ramda';
import sqlstring from 'sqlstring';
import { TABLE_NAMES, chQuery, formatClickhouseDate } from '../clickhouse/client';
import { clix } from '../clickhouse/query-builder';
import { createSqlBuilder } from '../sql-builder';
import { getEventFiltersWhereClause, getSelectPropertyKey } from './chart.service';

/**
 * Which slice of a chart the users are read for: one x-axis bucket (a point
 * on a line chart) or the report's whole date range (a bar or pie slice,
 * a metric card). Dates are already resolved to the project timezone.
 */
export type ChartProfilesScope =
  | { type: 'bucket'; date: Date; interval: IInterval }
  | { type: 'range'; startDate: Date | string; endDate: Date | string };

export interface GetChartProfileIdsInput {
  projectId: string;
  serie: Pick<IChartEvent, 'name' | 'filters'>;
  /** Breakdown property -> the value of the clicked series. */
  breakdowns?: Record<string, string>;
  scope: ChartProfilesScope;
}

/**
 * Distinct profile ids behind one series of an insights chart: the event
 * (or any event for '*'), the series' filters, the clicked breakdown values
 * and the time scope. Shared by the View Users modal and chart cohorts so
 * a cohort created from a chart holds exactly the users the modal listed.
 */
export async function getChartProfileIds({
  projectId,
  serie,
  breakdowns,
  scope,
}: GetChartProfileIdsInput): Promise<string[]> {
  const { sb, getSql } = createSqlBuilder();

  sb.select.profile_id = 'DISTINCT profile_id';
  sb.where = getEventFiltersWhereClause(serie.filters, projectId);
  sb.where.projectId = `project_id = ${sqlstring.escape(projectId)}`;
  if (scope.type === 'bucket') {
    sb.where.dateRange = `${clix.toStartOf('created_at', scope.interval)} = ${clix.toDate(sqlstring.escape(formatClickhouseDate(scope.date)), scope.interval)}`;
  } else {
    sb.where.dateRange = `created_at BETWEEN ${sqlstring.escape(formatClickhouseDate(scope.startDate))} AND ${sqlstring.escape(formatClickhouseDate(scope.endDate))}`;
  }
  if (serie.name !== '*') {
    sb.where.eventName = `name = ${sqlstring.escape(serie.name)}`;
  }

  // Profile fields referenced by filters or breakdowns need the join.
  const profileFields = [
    ...serie.filters
      .filter((f) => f.name.startsWith('profile.'))
      .map((f) => f.name.replace('profile.', '')),
    ...Object.keys(breakdowns ?? {})
      .filter((key) => key.startsWith('profile.'))
      .map((key) => key.replace('profile.', '')),
  ];
  if (profileFields.length > 0) {
    const fieldsToSelect = uniq(profileFields.map((f) => f.split('.')[0])).join(
      ', ',
    );
    sb.joins.profiles = `LEFT ANY JOIN (SELECT id, ${fieldsToSelect} FROM ${TABLE_NAMES.profiles} FINAL WHERE project_id = ${sqlstring.escape(projectId)}) as profile on profile.id = profile_id`;
  }

  const anyGroupRef =
    serie.filters.some((f) => f.name.startsWith('group.')) ||
    Object.keys(breakdowns ?? {}).some((key) => key.startsWith('group.'));
  if (anyGroupRef) {
    sb.joins.groups = 'ARRAY JOIN groups AS _group_id';
    sb.joins.groups_cte = `LEFT ANY JOIN (SELECT id, name, type, properties FROM ${TABLE_NAMES.groups} FINAL WHERE project_id = ${sqlstring.escape(projectId)}) AS _g ON _g.id = _group_id`;
  }

  for (const [key, value] of Object.entries(breakdowns ?? {})) {
    const propertyKey = getSelectPropertyKey(key, projectId);
    sb.where[`breakdown_${key}`] = `${propertyKey} = ${sqlstring.escape(value)}`;
  }

  const rows = await chQuery<{ profile_id: string }>(getSql());
  return rows.map((r) => r.profile_id).filter(Boolean);
}

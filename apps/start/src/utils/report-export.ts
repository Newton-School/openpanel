import type { useTRPC } from '@/integrations/trpc/react';
import type { QueryClient } from '@tanstack/react-query';
import type { IReportInput } from '@openpanel/validation';
import {
  aggregateToCSV,
  chartToCSV,
  downloadCSV,
  fileSlug,
  funnelToCSV,
} from './csv-download';

type Trpc = ReturnType<typeof useTRPC>;

/** Chart types whose plotted data has a tabular shape worth exporting. */
export const EXPORTABLE_CHART_TYPES: ReadonlySet<IReportInput['chartType']> =
  new Set([
    'linear',
    'bar',
    'area',
    'pie',
    'histogram',
    'metric',
    'map',
    'funnel',
  ]);

// Pie and bar plot one aggregated value per series and fetch through
// chart.aggregate; everything else in the set is a time series on chart.chart.
const AGGREGATE_CHART_TYPES: ReadonlySet<IReportInput['chartType']> = new Set([
  'pie',
  'bar',
]);

export function canExportReport(report: {
  chartType: IReportInput['chartType'];
  series: unknown[];
}) {
  // A report with no events has nothing to plot and the funnel endpoint
  // rejects it, so hide the export until a series exists.
  return EXPORTABLE_CHART_TYPES.has(report.chartType) && report.series.length > 0;
}

/**
 * Download the report's plotted data as CSV. Runs the same tRPC query the
 * chart component runs with the same input, so it is served from the
 * react-query cache when the chart is already on screen and costs nothing
 * extra; otherwise it fetches once. Returns the number of rows written; 0
 * means nothing was downloaded.
 */
export async function exportReportCsv({
  trpc,
  queryClient,
  report,
}: {
  trpc: Trpc;
  queryClient: QueryClient;
  report: IReportInput & { shareId?: string; visibleSeries?: unknown };
}) {
  const { visibleSeries: _visibleSeries, ...chartInput } = report;
  // The "all cohorts" breakdown is stored under the key `cohort`.
  const breakdownNames = report.breakdowns.map((b) =>
    b.name === 'cohort' ? 'Cohort' : b.name,
  );
  // Day and coarser buckets always land on midnight; drop the time part.
  const dateFormat: 'date' | 'datetime' =
    report.interval === 'minute' || report.interval === 'hour' ? 'datetime' : 'date';
  const rangePart =
    report.startDate && report.endDate
      ? `${report.startDate.slice(0, 10)}_to_${report.endDate.slice(0, 10)}`
      : report.range;
  const filename = `${fileSlug(report.name || 'report')}_${rangePart}.csv`;

  if (AGGREGATE_CHART_TYPES.has(report.chartType)) {
    const res = await queryClient.fetchQuery({
      ...trpc.chart.aggregate.queryOptions(chartInput),
      retry: false,
    });
    if (res.series.length === 0) {
      return 0;
    }
    downloadCSV(aggregateToCSV(res.series, breakdownNames), filename);
    return res.series.length;
  }

  if (report.chartType === 'funnel') {
    const res = await queryClient.fetchQuery({
      ...trpc.chart.funnel.queryOptions(chartInput),
      retry: false,
    });
    if (res.current.length === 0) {
      return 0;
    }
    downloadCSV(funnelToCSV(res.current, breakdownNames), filename);
    return res.current.length;
  }

  const res = await queryClient.fetchQuery({
    ...trpc.chart.chart.queryOptions(chartInput),
    retry: false,
  });
  if (res.series.length === 0) {
    return 0;
  }
  downloadCSV(chartToCSV(res.series, breakdownNames, dateFormat), filename);
  return res.series.length;
}

import type { useTRPC } from '@/integrations/trpc/react';
import type { QueryClient } from '@tanstack/react-query';
import type { IReportInput } from '@openpanel/validation';
import { chartToCSV, downloadCSV, fileSlug, funnelToCSV } from './csv-download';

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

export function canExportReport(chartType: IReportInput['chartType']) {
  return EXPORTABLE_CHART_TYPES.has(chartType);
}

/**
 * Download the report's plotted data as CSV. Runs the same tRPC query the
 * chart component runs with the same input, so it is served from the
 * react-query cache when the chart is already on screen and costs nothing
 * extra; otherwise it fetches once.
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

  if (report.chartType === 'funnel') {
    const res = await queryClient.fetchQuery({
      ...trpc.chart.funnel.queryOptions(chartInput),
      retry: false,
    });
    downloadCSV(funnelToCSV(res.current, breakdownNames), filename);
    return res.current.length;
  }

  const res = await queryClient.fetchQuery({
    ...trpc.chart.chart.queryOptions(chartInput),
    retry: false,
  });
  downloadCSV(chartToCSV(res.series, breakdownNames, dateFormat), filename);
  return res.series.length;
}

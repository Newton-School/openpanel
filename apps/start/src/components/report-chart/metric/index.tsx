import { useTRPC } from '@/integrations/trpc/react';
import type { IChartEventSegment } from '@openpanel/validation';
import { keepPreviousData, useQuery } from '@tanstack/react-query';

import { AspectContainer } from '../aspect-container';
import { ReportChartEmpty } from '../common/empty';
import { ReportChartError } from '../common/error';
import { useChartInput, useReportChartContext } from '../context';
import { Chart } from './chart';

// Segments whose whole-range value follows from the time series itself.
const HEADLINE_FROM_SERIES = new Set<IChartEventSegment>([
  'event',
  'user',
  'property_sum',
  'property_min',
  'property_max',
]);

export function ReportMetricChart() {
  const { isLazyLoading, shareId } = useReportChartContext();
  const chartInput = useChartInput();
  const trpc = useTRPC();

  const res = useQuery(
    trpc.chart.chart.queryOptions(
      {
        ...chartInput,
        shareId,
      },
      {
        placeholderData: keepPreviousData,
        staleTime: 1000 * 60 * 1,
        enabled: !isLazyLoading,
      },
    ),
  );

  // Newton fork: the headline number is the whole-range value of the
  // segment, not the unique-user total the card used to show. For counts,
  // sums, min/max and unique users the time series already carries it (sum
  // of buckets, or the exact uniqMerge total_count), so no extra query. For
  // averages, medians, percentiles and per-user aggregations the buckets
  // cannot be combined client-side, so those fetch the whole-range aggregate
  // (same query pie/bar use). The time series above always draws the
  // sparkline.
  // Formulas need it too: the engine applies the formula to the whole-range
  // input values there, which is the only sensible headline for e.g. A / B.
  const needsAggregate = chartInput.series.some(
    (serie) =>
      serie.type === 'formula' ||
      (serie.type === 'event' && !HEADLINE_FROM_SERIES.has(serie.segment)),
  );
  const aggregate = useQuery(
    trpc.chart.aggregate.queryOptions(
      {
        ...chartInput,
        shareId,
      },
      {
        placeholderData: keepPreviousData,
        staleTime: 1000 * 60 * 1,
        enabled: !isLazyLoading && needsAggregate,
      },
    ),
  );

  if (
    isLazyLoading ||
    res.isLoading ||
    (res.isFetching && !res.data?.series.length)
  ) {
    return <Loading />;
  }

  if (res.isError) {
    return <Error />;
  }

  if (!res.data || res.data?.series.length === 0) {
    return <Empty />;
  }

  return <Chart data={res.data} aggregate={aggregate.data} />;
}

export function Loading() {
  return (
    <div className="flex h-[78px] flex-col justify-between p-4">
      <div className="h-3 w-1/2 animate-pulse rounded bg-def-200" />
      <div className="row items-end justify-between">
        <div className="h-6 w-1/3 animate-pulse rounded bg-def-200" />
        <div className="h-3 w-1/5 animate-pulse rounded bg-def-200" />
      </div>
    </div>
  );
}

function Error() {
  return (
    <AspectContainer>
      <ReportChartError />
    </AspectContainer>
  );
}

function Empty() {
  return (
    <AspectContainer>
      <ReportChartEmpty />
    </AspectContainer>
  );
}

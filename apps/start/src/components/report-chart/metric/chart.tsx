import { useVisibleSeries } from '@/hooks/use-visible-series';
import type { IChartData, RouterOutputs } from '@/trpc/client';
import { cn } from '@/utils/cn';
import type { IChartMetric } from '@openpanel/validation';

import { useChartInput, useReportChartContext } from '../context';
import { MetricCard } from './metric-card';

type AggregateData = RouterOutputs['chart']['aggregate'];

// Segments whose whole-range value follows from the time series itself
// (sum of buckets, or the exact uniqMerge total_count). Every other segment,
// and formulas, need the whole-range aggregate query for the headline.
export const HEADLINE_FROM_SERIES = new Set<string>([
  'event',
  'user',
  'property_sum',
  'property_min',
  'property_max',
]);

export type AggregateState = 'idle' | 'loading' | 'ready' | 'error';

// Whole-range value derivable from the time series, used when no aggregate
// query was issued for the segment (see ReportMetricChart).
function seriesMetricFor(segment: string | undefined): IChartMetric {
  switch (segment) {
    case 'user':
    case 'formula':
      // uniqMerge total over the range; for formulas the formula applied to
      // the inputs' totals, shown only until the aggregate arrives.
      return 'count';
    case 'property_min':
      return 'min';
    case 'property_max':
      return 'max';
    default:
      return 'sum';
  }
}

interface Props {
  data: IChartData;
  aggregate?: AggregateData;
  aggregateState: AggregateState;
}

export function Chart({ data, aggregate, aggregateState }: Props) {
  const {
    isEditMode,
    report: { unit },
  } = useReportChartContext();
  const { series } = useVisibleSeries(data, { limit: isEditMode ? 20 : 4 });
  // serie.event.id is the report series id, so look the segment up there.
  const chartInput = useChartInput();
  const segmentById = new Map(
    chartInput.series.map((s) => [
      s.id,
      s.type === 'event' ? s.segment : 'formula',
    ]),
  );
  // The two procedures build series ids differently, but the display names
  // (event name + breakdown values) are identical, so match on those.
  const seriesKey = (names: string[]) => names.join('\u0000');
  const aggregateByName = new Map(
    (aggregate?.series ?? []).map(
      (serie) => [seriesKey(serie.names), serie] as const,
    ),
  );
  return (
    <div
      className={cn(
        'grid grid-cols-1 gap-4',
        isEditMode && 'md:grid-cols-2 lg:grid-cols-3',
      )}
    >
      {series.map((serie) => {
        const segment = segmentById.get(serie.event.id);
        if (segment && HEADLINE_FROM_SERIES.has(segment)) {
          return (
            <MetricCard
              key={serie.id}
              serie={serie}
              metric={seriesMetricFor(segment)}
              unit={unit}
            />
          );
        }
        const headline = aggregateByName.get(seriesKey(serie.names))?.metrics;
        // No match once the aggregate is in: the series was cut by the
        // aggregate's own ranking limit. Show N/A rather than a wrong number.
        const headlineState = headline
          ? 'ready'
          : aggregateState === 'loading' || aggregateState === 'idle'
            ? 'loading'
            : 'unavailable';
        return (
          <MetricCard
            key={serie.id}
            serie={serie}
            metric={seriesMetricFor(segment)}
            headline={headline}
            headlineState={headlineState}
            unit={unit}
          />
        );
      })}
    </div>
  );
}

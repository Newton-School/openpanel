import { useVisibleSeries } from '@/hooks/use-visible-series';
import type { IChartData, RouterOutputs } from '@/trpc/client';
import { cn } from '@/utils/cn';
import type { IChartMetric } from '@openpanel/validation';

import { useChartInput, useReportChartContext } from '../context';
import { MetricCard } from './metric-card';

type AggregateData = RouterOutputs['chart']['aggregate'];

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
}

export function Chart({ data, aggregate }: Props) {
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
        return (
          <MetricCard
            key={serie.id}
            serie={serie}
            metric={seriesMetricFor(segmentById.get(serie.event.id))}
            headline={aggregateByName.get(seriesKey(serie.names))?.metrics}
            unit={unit}
          />
        );
      })}
    </div>
  );
}

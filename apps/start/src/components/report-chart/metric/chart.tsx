import { useVisibleSeries } from '@/hooks/use-visible-series';
import type { IChartData, RouterOutputs } from '@/trpc/client';
import { cn } from '@/utils/cn';

import { useReportChartContext } from '../context';
import { MetricCard } from './metric-card';

type AggregateData = RouterOutputs['chart']['aggregate'];

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
            metric={'count'}
            headline={aggregateByName.get(seriesKey(serie.names))?.metrics}
            unit={unit}
          />
        );
      })}
    </div>
  );
}

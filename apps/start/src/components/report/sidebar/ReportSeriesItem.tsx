import { ColorSquare } from '@/components/color-square';
import { useEffect, useState } from 'react';
import { DropdownMenuComposed } from '@/components/ui/dropdown-menu';
import { useDispatch } from '@/redux';
import { shortId } from '@openpanel/common';
import {
  alphabetIds,
  DEFAULT_PROPERTY_PERCENTILE,
  propertyInnerAggregations,
  propertyOuterAggregations,
  propertyPercentiles,
} from '@openpanel/constants';
import { type IChartEvent, type IChartEventItem, mapKeys } from '@openpanel/validation';
import {
  DatabaseIcon,
  FilterIcon,
  type LucideIcon,
  PercentIcon,
  SigmaIcon,
  UsersIcon,
} from 'lucide-react';
import { ReportSegment } from '../ReportSegment';
import { changeEvent } from '../reportSlice';
import { PropertiesCombobox } from './PropertiesCombobox';
import { FiltersList } from './filters/FiltersList';

export interface ReportSeriesItemProps
  extends React.HTMLAttributes<HTMLDivElement> {
  event: IChartEventItem | IChartEvent;
  index: number;
  showSegment: boolean;
  showAddFilter: boolean;
  isSelectManyEvents: boolean;
  renderDragHandle?: (index: number) => React.ReactNode;
}

export function ReportSeriesItem({
  event,
  index,
  showSegment,
  showAddFilter,
  isSelectManyEvents,
  renderDragHandle,
  ...props
}: ReportSeriesItemProps) {
  const dispatch = useDispatch();

  // Normalize event to have type field
  const normalizedEvent: IChartEventItem =
    'type' in event ? event : { ...event, type: 'event' as const };

  const isFormula = normalizedEvent.type === 'formula';
  const chartEvent = isFormula
    ? null
    : (normalizedEvent as IChartEventItem & { type: 'event' });

  return (
    <div {...props}>
      <div className="flex items-center gap-2 p-2 group">
        {renderDragHandle ? (
          renderDragHandle(index)
        ) : (
          <ColorSquare>
            <span className="block">{alphabetIds[index]}</span>
          </ColorSquare>
        )}
        {props.children}
      </div>

      {/* Segment and Filter buttons - only for events */}
      {chartEvent && (showSegment || showAddFilter) && (
        <div className="flex flex-wrap gap-2 p-2 pt-0">
          {showSegment && (
            <ReportSegment
              value={chartEvent.segment}
              onChange={(segment) => {
                dispatch(
                  changeEvent({
                    ...chartEvent,
                    segment,
                  }),
                );
              }}
            />
          )}
          {showAddFilter && (
            <PropertiesCombobox
              event={chartEvent}
              showCohorts
              onSelect={(action) => {
                dispatch(
                  changeEvent({
                    ...chartEvent,
                    filters: [
                      ...chartEvent.filters,
                      action.cohortId
                        ? {
                            id: shortId(),
                            name: action.value,
                            operator: 'inCohort',
                            value: [],
                            cohortId: action.cohortId,
                          }
                        : {
                            id: shortId(),
                            name: action.value,
                            operator: 'is',
                            value: [],
                          },
                    ],
                  }),
                );
              }}
            >
              {(setOpen) => (
                <SmallButton
                  onClick={() => setOpen((p) => !p)}
                  icon={FilterIcon}
                >
                  Add filter
                </SmallButton>
              )}
            </PropertiesCombobox>
          )}

          {showSegment && chartEvent.segment.startsWith('property_') && (
            <PropertiesCombobox
              include={chartEvent.name === 'session_end' ? ['duration'] : []}
              event={chartEvent}
              onSelect={(item) => {
                dispatch(
                  changeEvent({
                    ...chartEvent,
                    property: item.value,
                    type: 'event',
                  }),
                );
              }}
            >
              {(setOpen) => (
                <SmallButton
                  icon={DatabaseIcon}
                  onClick={() => setOpen((p) => !p)}
                >
                  {chartEvent.property
                    ? `Property: ${chartEvent.property}`
                    : 'Select property'}
                </SmallButton>
              )}
            </PropertiesCombobox>
          )}

          {/* Two-layer aggregation: per-user (inner) then across users (outer). */}
          {showSegment && chartEvent.segment === 'property_per_user' && (
            <>
              <DropdownMenuComposed
                label="Per user"
                items={mapKeys(propertyInnerAggregations).map((key) => ({
                  value: key,
                  label: propertyInnerAggregations[key],
                }))}
                onChange={(propertyInner) =>
                  dispatch(changeEvent({ ...chartEvent, propertyInner, type: 'event' }))
                }
              >
                <SmallButton icon={UsersIcon}>
                  {`Per user: ${propertyInnerAggregations[chartEvent.propertyInner ?? 'sum']}`}
                </SmallButton>
              </DropdownMenuComposed>
              <DropdownMenuComposed
                label="Across users"
                items={mapKeys(propertyOuterAggregations).map((key) => ({
                  value: key,
                  label: propertyOuterAggregations[key],
                }))}
                onChange={(propertyOuter) =>
                  dispatch(changeEvent({ ...chartEvent, propertyOuter, type: 'event' }))
                }
              >
                <SmallButton icon={SigmaIcon}>
                  {`Then: ${propertyOuterAggregations[chartEvent.propertyOuter ?? 'average']}`}
                </SmallButton>
              </DropdownMenuComposed>
            </>
          )}

          {showSegment &&
            (chartEvent.segment === 'property_percentile' ||
              (chartEvent.segment === 'property_per_user' &&
                chartEvent.propertyOuter === 'percentile')) && (
              <PercentileInput
                value={
                  chartEvent.propertyPercentile ?? DEFAULT_PROPERTY_PERCENTILE
                }
                onChange={(percentile) =>
                  dispatch(
                    changeEvent({
                      ...chartEvent,
                      propertyPercentile: percentile,
                      type: 'event',
                    }),
                  )
                }
              />
            )}
        </div>
      )}

      {/* Filters - only for events */}
      {chartEvent && !isSelectManyEvents && <FiltersList event={chartEvent} />}
    </div>
  );
}

// Any whole percentile 0-100, typed directly (P0 = minimum, P100 = maximum).
// Product wants arbitrary cut-offs ("the top 37% of users"), so this is an
// input with the common values as suggestions rather than a fixed list.
// Committed on Enter or blur so typing "3" then "37" runs one query.
function PercentileInput({
  value,
  onChange,
}: {
  value: number;
  onChange: (percentile: number) => void;
}) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => {
    setDraft(String(value));
  }, [value]);
  const commit = () => {
    const parsed = Math.round(Number(draft));
    if (Number.isNaN(parsed) || parsed < 0 || parsed > 100) {
      setDraft(String(value));
      return;
    }
    if (parsed !== value) {
      onChange(parsed);
    }
  };
  return (
    <label className="flex items-center gap-1 rounded-md border border-border bg-card p-1 px-2 text-sm font-medium leading-none">
      <PercentIcon size={12} className="shrink-0" />
      <span>P</span>
      <input
        type="number"
        inputMode="numeric"
        min={0}
        max={100}
        step={1}
        list="percentile-presets"
        aria-label="Percentile (0-100)"
        title="Percentile, 0-100. P0 is the minimum, P100 the maximum."
        className="w-10 bg-transparent outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            e.currentTarget.blur();
          }
        }}
      />
      <datalist id="percentile-presets">
        {propertyPercentiles.map((p) => (
          <option key={p} value={p} />
        ))}
      </datalist>
    </label>
  );
}

function SmallButton({
  children,
  icon: Icon,
  ...props
}: {
  children: React.ReactNode;
  icon: LucideIcon;
} & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      className="flex items-center gap-1 rounded-md border border-border bg-card p-1 px-2 text-sm font-medium leading-none text-left min-w-0"
      {...props}
    >
      <Icon size={12} className="shrink-0" />
      <span className="truncate">{children}</span>
    </button>
  );
}

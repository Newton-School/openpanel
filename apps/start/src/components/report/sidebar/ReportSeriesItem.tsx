import { ColorSquare } from '@/components/color-square';
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
              <DropdownMenuComposed
                label="Percentile"
                items={propertyPercentiles.map((p) => ({
                  value: String(p),
                  label: `P${p}`,
                }))}
                onChange={(value) =>
                  dispatch(
                    changeEvent({
                      ...chartEvent,
                      propertyPercentile: Number(value),
                      type: 'event',
                    }),
                  )
                }
              >
                <SmallButton icon={PercentIcon}>
                  {`P${chartEvent.propertyPercentile ?? DEFAULT_PROPERTY_PERCENTILE}`}
                </SmallButton>
              </DropdownMenuComposed>
            )}
        </div>
      )}

      {/* Filters - only for events */}
      {chartEvent && !isSelectManyEvents && <FiltersList event={chartEvent} />}
    </div>
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

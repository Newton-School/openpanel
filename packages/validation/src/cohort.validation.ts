import { operators } from '@openpanel/constants';
import { z } from 'zod';

// Defined locally to avoid a runtime TDZ from cohort.validation being
// imported before index.ts has finished initializing zChartEventFilter.
// Keep in sync with zChartEventFilter in ./index.ts.
function objectToZodEnums<K extends string>(obj: Record<K, unknown>): [K, ...K[]] {
  const [firstKey, ...otherKeys] = Object.keys(obj) as K[];
  return [firstKey!, ...otherKeys];
}

const zChartEventFilter = z.object({
  id: z.string().optional().describe('Unique identifier for the filter'),
  name: z.string().describe('The property name to filter on'),
  operator: z
    .enum(objectToZodEnums(operators))
    .describe('The operator to use for the filter'),
  value: z
    .array(z.string().or(z.number()).or(z.boolean()).or(z.null()))
    .describe('The values to filter on'),
  cohortId: z
    .string()
    .optional()
    .describe('Cohort ID when using inCohort/notInCohort operators'),
});

export const zRelativeTimeframe = z.object({
  type: z.literal('relative'),
  value: z.enum(['7d', '30d', '90d', '180d', '365d']),
});

export const zAbsoluteTimeframe = z.object({
  type: z.literal('absolute'),
  start: z.string(),
  end: z.string().optional(),
});

export const zTimeframe = z.discriminatedUnion('type', [
  zRelativeTimeframe,
  zAbsoluteTimeframe,
]);

export type Timeframe = z.infer<typeof zTimeframe>;

export const zFrequency = z.object({
  operator: z.enum(['gte', 'eq', 'lte']),
  count: z.number().int().min(1),
});

export type Frequency = z.infer<typeof zFrequency>;

export const zEventCriteria = z.object({
  name: z.string().min(1).describe('The event name to match'),
  filters: z
    .array(zChartEventFilter)
    .default([])
    .describe('Filters applied to event properties'),
  timeframe: zTimeframe.describe('When the event should have occurred'),
  frequency: zFrequency
    .optional()
    .describe('How many times the event should have occurred'),
});

export type EventCriteria = z.infer<typeof zEventCriteria>;

export const zEventBasedCohortDefinition = z.object({
  type: z.literal('event'),
  criteria: z.object({
    operator: z.enum(['and', 'or']).describe('How to combine multiple events'),
    events: z
      .array(zEventCriteria)
      .min(1)
      .describe('Array of event criteria to match'),
  }),
});

export type EventBasedCohortDefinition = z.infer<
  typeof zEventBasedCohortDefinition
>;

export const zPropertyBasedCohortDefinition = z.object({
  type: z.literal('property'),
  criteria: z.object({
    operator: z
      .enum(['and', 'or'])
      .describe('How to combine multiple properties'),
    properties: z
      .array(zChartEventFilter)
      .min(1)
      .describe('Array of profile property filters'),
  }),
});

export type PropertyBasedCohortDefinition = z.infer<
  typeof zPropertyBasedCohortDefinition
>;

// Local mirror of the event series item in ./index.ts (same TDZ reason as
// zChartEventFilter above). Only the fields the funnel query reads.
const zFunnelCohortSeriesItem = z.object({
  id: z.string().optional(),
  type: z.literal('event'),
  name: z.string(),
  displayName: z.string().nullish(),
  segment: z.string().optional(),
  filters: z.array(zChartEventFilter).default([]),
  property: z.string().nullish(),
});

/**
 * "Users at a funnel step": the same inputs the funnel report's View Users
 * modal sends, stored so the cohort recomputes against the live funnel.
 * A relative `range` (e.g. 30d) moves with time on every refresh; explicit
 * startDate/endDate pin it. Freeze with isStatic for a one-time snapshot.
 */
export const zFunnelCohortDefinition = z.object({
  type: z.literal('funnel'),
  criteria: z.object({
    series: z.array(zFunnelCohortSeriesItem).min(1),
    stepIndex: z.number().int().min(0).describe('0-based funnel step'),
    showDropoffs: z
      .boolean()
      .default(false)
      .describe('true = dropped after this step, false = completed it'),
    funnelWindow: z.number().optional(),
    funnelGroup: z.string().optional(),
    breakdowns: z.array(z.object({ name: z.string() })).default([]),
    breakdownValues: z.array(z.string()).default([]),
    range: z.string(),
    startDate: z.string().nullish(),
    endDate: z.string().nullish(),
  }),
});

export type FunnelCohortDefinition = z.infer<typeof zFunnelCohortDefinition>;

export const zCohortDefinition = z.discriminatedUnion('type', [
  zEventBasedCohortDefinition,
  zPropertyBasedCohortDefinition,
  zFunnelCohortDefinition,
]);

export type CohortDefinition = z.infer<typeof zCohortDefinition>;

export const zCohortInput = z.object({
  name: z
    .string()
    .min(1)
    .max(255)
    .describe('User-friendly name for the cohort'),
  description: z
    .string()
    .max(1000)
    .optional()
    .describe('Optional description of the cohort'),
  projectId: z.string().describe('The project this cohort belongs to'),
  definition: zCohortDefinition.describe('The cohort criteria definition'),
  isStatic: z
    .boolean()
    .default(false)
    .describe(
      'Whether this cohort is frozen — if true, membership is computed once and not auto-refreshed',
    ),
});

export type CohortInput = z.infer<typeof zCohortInput>;

export const zCohortUpdate = z.object({
  id: z.string().describe('The cohort ID to update'),
  name: z.string().min(1).max(255).optional(),
  description: z.string().max(1000).optional().nullable(),
  definition: zCohortDefinition.optional(),
  isStatic: z.boolean().optional(),
});

export type CohortUpdate = z.infer<typeof zCohortUpdate>;

export const zCohortFilter = z.object({
  cohortId: z.string().describe('The cohort ID to filter by'),
  operator: z
    .enum(['inCohort', 'notInCohort'])
    .default('inCohort')
    .describe('Whether to include or exclude cohort members'),
});

export type CohortFilter = z.infer<typeof zCohortFilter>;

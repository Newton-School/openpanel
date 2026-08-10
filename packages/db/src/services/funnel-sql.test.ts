import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IChartEvent } from '@openpanel/validation';

const eventSeries: IChartEvent[] = [
  {
    id: '1',
    name: 'sign_up',
    displayName: 'sign_up',
    segment: 'event',
    filters: [],
  },
  {
    id: '2',
    name: 'purchase',
    displayName: 'purchase',
    segment: 'event',
    filters: [],
  },
];

function buildFunnelSql(funnelService: any): string {
  return funnelService
    .buildFunnelCte({
      projectId: 'p1',
      startDate: '2026-06-01 00:00:00',
      endDate: '2026-06-02 00:00:00',
      eventSeries,
      funnelWindowMilliseconds: 86_400_000,
      timezone: 'UTC',
    })
    .toSQL();
}

// The funnel CTE qualifies columns as `events.*` (conditions, name filter,
// profile/cohort joins), so whatever table eventsRead points at must be
// aliased AS events — otherwise ClickHouse fails with UNKNOWN_IDENTIFIER.
describe('funnel CTE events alias', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('aliases events_resolved AS events when NEWTON_RESOLVE_PROFILE=1', async () => {
    vi.stubEnv('NEWTON_RESOLVE_PROFILE', '1');
    const { funnelService } = await import('./funnel.service');
    const sql = buildFunnelSql(funnelService);
    expect(sql).toContain('events.name');
    expect(sql).toContain('FROM events_resolved AS events');
  });

  it('keeps the events alias when the flag is off', async () => {
    vi.stubEnv('NEWTON_RESOLVE_PROFILE', '');
    const { funnelService } = await import('./funnel.service');
    const sql = buildFunnelSql(funnelService);
    expect(sql).toContain('FROM events AS events');
  });
});

// The profiles join must only carry the referenced property keys as scalar
// columns — joining every profile's whole properties Map costs multi-GiB per
// funnel. Conditions are rewritten to the scalar aliases via
// profilePropertyKeys (same mechanism as the chart profile CTE).
describe('funnel profile-property scalar rewrite', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv('NEWTON_RESOLVE_PROFILE', '1');
  });

  it('rewrites profile.properties refs in funnel conditions to scalar aliases', async () => {
    const { funnelService } = await import('./funnel.service');
    const sql = funnelService
      .buildFunnelCte({
        projectId: 'p1',
        startDate: '2026-06-01 00:00:00',
        endDate: '2026-06-02 00:00:00',
        eventSeries: [
          {
            id: '1',
            name: 'sign_up',
            displayName: 'sign_up',
            segment: 'event',
            filters: [
              {
                id: 'f1',
                name: 'profile.properties.plan',
                operator: 'is',
                value: ['pro'],
              },
            ],
          },
          eventSeries[1]!,
        ],
        funnelWindowMilliseconds: 86_400_000,
        timezone: 'UTC',
        profilePropertyKeys: ['plan'],
      })
      .toSQL();
    expect(sql).toContain('`profile.properties.plan`');
    expect(sql).not.toContain("profile.properties['plan']");
  });

  it('leaves conditions untouched when no keys are passed', async () => {
    const { funnelService } = await import('./funnel.service');
    const sql = buildFunnelSql(funnelService);
    expect(sql).not.toContain('`profile.properties.');
  });
});

// "View Users" on a funnel step must evaluate the exact same funnel as the
// chart (NS-13549). The old hand-rolled query in the trpc router selected
// `profile.properties[...]` for profile-property breakdowns without joining
// profiles (UNKNOWN_IDENTIFIER → the modal showed "No users found"), and it
// grouped windowFunnel by the breakdown value, splitting sequences.
describe('funnel profile ids query (View Users modal)', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv('NEWTON_RESOLVE_PROFILE', '1');
  });

  const base = {
    projectId: 'p1',
    startDate: '2026-06-01 00:00:00',
    endDate: '2026-06-02 00:00:00',
    series: eventSeries.map((s) => ({ ...s, type: 'event' as const })),
    stepIndex: 0,
    funnelWindow: 0.2,
    funnelGroup: 'profile_id',
    timezone: 'UTC',
  };

  it('joins profiles and rewrites refs for profile-property breakdowns', async () => {
    const { funnelService } = await import('./funnel.service');
    const query = await funnelService.buildFunnelProfileIdsQuery({
      ...base,
      breakdowns: [{ name: 'profile.properties.experiment' }],
      breakdownValues: ['control'],
    });
    const sql = query.toSQL();
    expect(sql).toContain('as profile');
    expect(sql).toContain('`profile.properties.experiment`');
    expect(sql).not.toContain("profile.properties['experiment']");
  });

  it('attributes breakdowns at the entry step instead of grouping by them', async () => {
    const { funnelService } = await import('./funnel.service');
    const query = await funnelService.buildFunnelProfileIdsQuery({
      ...base,
      breakdowns: [{ name: 'properties.experiment' }],
      breakdownValues: ['control'],
    });
    const sql = query.toSQL();
    expect(sql).toContain('argMinIf(');
    expect(sql).not.toContain('GROUP BY profile_id, b_0');
    expect(sql).toContain("trim(b_0) = 'control'");
  });

  it('filters level >= step for completed and = step for dropoffs', async () => {
    const { funnelService } = await import('./funnel.service');
    const completed = (
      await funnelService.buildFunnelProfileIdsQuery({ ...base, stepIndex: 1 })
    ).toSQL();
    expect(completed).toContain('level >= 2');
    const dropped = (
      await funnelService.buildFunnelProfileIdsQuery({
        ...base,
        stepIndex: 1,
        showDropoffs: true,
      })
    ).toSQL();
    expect(dropped).toContain('level = 2');
  });

  it('matches empty raw values when the clicked row is "Not set"', async () => {
    const { funnelService } = await import('./funnel.service');
    const query = await funnelService.buildFunnelProfileIdsQuery({
      ...base,
      breakdowns: [{ name: 'properties.experiment' }],
      breakdownValues: ['Not set'],
    });
    const sql = query.toSQL();
    expect(sql).toContain("trim(b_0) = ''");
  });
});

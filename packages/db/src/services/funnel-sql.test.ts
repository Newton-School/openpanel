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

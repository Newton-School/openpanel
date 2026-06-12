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

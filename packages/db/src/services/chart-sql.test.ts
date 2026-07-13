import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IChartEvent } from '@openpanel/validation';

const baseEvent: IChartEvent = {
  id: '1',
  name: 'sign_up',
  displayName: 'sign_up',
  segment: 'event',
  filters: [],
};

async function buildChartSql(overrides: Record<string, unknown> = {}) {
  const { getChartSql } = await import('./chart.service');
  return getChartSql({
    event: baseEvent,
    breakdowns: [],
    interval: 'day',
    startDate: '2026-06-01 00:00:00',
    endDate: '2026-06-02 00:00:00',
    projectId: 'p1',
    timezone: 'UTC',
    ...overrides,
  } as unknown as Parameters<typeof getChartSql>[0]);
}

// total_count (unique visitors over the whole range) used to be computed by a
// `_uc` CTE that re-ran the entire WHERE in a second full scan. It is now a
// uniqState aggregated in the same pass and merged with a window aggregate in
// an outer select, so every chart reads the events table exactly once.
describe('chart sql single-pass total_count', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv('NEWTON_RESOLVE_PROFILE', '1');
  });

  it('scans events exactly once and merges uniq states globally (no breakdown)', async () => {
    const sql = await buildChartSql();
    expect(sql).not.toContain('_uc AS (');
    expect(sql).toContain('uniqState(profile_id) as _uc_state');
    expect(sql).toContain('uniqMerge(_uc_state) OVER () as total_count');
    expect(sql).toContain('* EXCEPT (_uc_state)');
    // exactly one scan of the events source
    expect(sql.match(/FROM events_resolved e/g)).toHaveLength(1);
    expect(sql).not.toMatch(/FROM events e/);
  });

  it('partitions the merged uniq states by breakdown labels', async () => {
    const sql = await buildChartSql({
      breakdowns: [{ id: 'b1', name: 'properties.courseStructureSlug' }],
    });
    expect(sql).not.toContain('_uc AS (');
    expect(sql).not.toContain('LEFT ANY JOIN _uc');
    expect(sql).toContain(
      'uniqMerge(_uc_state) OVER (PARTITION BY label_1) as total_count',
    );
    expect(sql.match(/FROM events_resolved e/g)).toHaveLength(1);
  });

  it('keeps ORDER BY and WITH FILL outside the aggregation subquery', async () => {
    const sql = await buildChartSql();
    // GROUP BY belongs to the inner scan; ORDER BY/FILL follow its closing paren
    expect(sql).toMatch(/GROUP BY[^)]*\)\s*ORDER BY date ASC/);
    expect(sql).toContain('WITH FILL');
  });

  it('reads raw events for profile-filtered charts (index-safe path)', async () => {
    const sql = await buildChartSql({
      event: {
        ...baseEvent,
        filters: [
          {
            id: 'f1',
            name: 'profile_id',
            operator: 'is',
            value: ['abc'],
          },
        ],
      },
    });
    // profile-filtered charts must stay on the raw table for the bloom index
    expect(sql.match(/FROM events e/g)).toHaveLength(1);
    expect(sql).not.toContain('FROM events_resolved');
  });
});

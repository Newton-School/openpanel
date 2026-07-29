import { describe, expect, it } from 'vitest';
import type { PropertyBasedCohortDefinition } from '@openpanel/validation';

async function buildSql(
  criteria: PropertyBasedCohortDefinition['criteria'],
  limit?: number,
) {
  const { buildPropertyBasedCohortQuery } = await import('./cohort.service');
  return buildPropertyBasedCohortQuery(
    'p1',
    { type: 'property', criteria } as PropertyBasedCohortDefinition,
    limit,
  );
}

const mapFilter = {
  id: 'a',
  name: 'profile.properties.experiment',
  operator: 'is' as const,
  value: ['control'],
};

describe('buildPropertyBasedCohortQuery', () => {
  it('resolves the newest row per profile without FINAL', async () => {
    const sql = await buildSql({ operator: 'and', properties: [mapFilter] });

    // FINAL cannot spill to disk and needed 2.4-3.0GiB on this table.
    expect(sql).not.toContain('FINAL');
    expect(sql).toContain('GROUP BY id');
    expect(sql).toContain(
      "argMax(profiles.properties['experiment'], tuple(created_at, profiles.properties['experiment']))",
    );
  });

  it('filters aggregates in HAVING, not WHERE', async () => {
    const sql = await buildSql({ operator: 'and', properties: [mapFilter] });

    const having = sql.indexOf('HAVING');
    expect(having).toBeGreaterThan(-1);
    expect(sql.indexOf('argMax')).toBeGreaterThan(having);
  });

  it('wraps plain columns too, so mixed cohorts stay on one scan', async () => {
    const sql = await buildSql({
      operator: 'or',
      properties: [
        mapFilter,
        { id: 'b', name: 'profile.email', operator: 'contains' as const, value: ['ns'] },
      ],
    });

    expect(sql).toContain('argMax(profiles.email, tuple(created_at,');
    expect(sql).toContain(' OR ');
    expect(sql).not.toContain('FINAL');
  });

  it('applies the limit', async () => {
    const sql = await buildSql({ operator: 'and', properties: [mapFilter] }, 10);

    expect(sql).toContain('LIMIT 10');
  });

  it('matches nothing when every filter was dropped as empty', async () => {
    const sql = await buildSql({
      operator: 'and',
      properties: [{ id: 'a', name: 'profile.properties.x', operator: 'is' as const, value: [] }],
    });

    expect(sql).toContain('WHERE 1=0');
    expect(sql).not.toContain('argMax');
  });
});

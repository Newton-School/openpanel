import fs from 'node:fs';
import path from 'node:path';
import { runClickhouseMigrationCommands } from '../src/clickhouse/migration';

/**
 * Newton fork: data-skipping index on events.profile_id.
 *
 * The events table sorts by (project_id, toDate(created_at), created_at, name)
 * and had NO index on profile_id. That was fine at small scale, but after the
 * historical backfill (~160M rows) every profile-scoped query — the profile
 * panel, per-profile event lists/counts, profile-filtered charts — full-scanned
 * the whole table (seconds to minutes). A `bloom_filter` index makes both
 * `profile_id = X` and `profile_id IN (...)` prune to the few granules holding
 * that profile, which is exactly what the anon->identified set-expansion
 * (profileIdInClause / cohortMembersInClause) relies on.
 *
 * This migration only ADDs the index (cheap, metadata-level, idempotent). For an
 * environment whose events table ALREADY holds data, the index must also be
 * built for existing parts with `MATERIALIZE INDEX` — a heavy one-time mutation
 * kept out of the migration so it doesn't re-run on every deploy. See the
 * companion `17-profile-id-index.admin.sql` (already run on prod 2026-06-12).
 * Fresh installs start with an empty events table, so ADD INDEX alone suffices.
 */

const DB = 'openpanel';

export async function up() {
  const sqls = [
    `ALTER TABLE ${DB}.events ADD INDEX IF NOT EXISTS idx_profile_id profile_id TYPE bloom_filter(0.01) GRANULARITY 1`,
  ];

  fs.writeFileSync(
    path.join(import.meta.filename.replace('.ts', '.sql')),
    sqls.map((sql) => sql.trim().replace(/;$/, '').concat(';')).join('\n\n---\n\n')
  );

  if (!process.argv.includes('--dry')) {
    await runClickhouseMigrationCommands(sqls);
  }
}

export async function down() {
  await runClickhouseMigrationCommands([
    `ALTER TABLE ${DB}.events DROP INDEX IF EXISTS idx_profile_id`,
  ]);
}

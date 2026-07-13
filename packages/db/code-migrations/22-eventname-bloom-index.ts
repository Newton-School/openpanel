import fs from 'node:fs';
import path from 'node:path';
import { runClickhouseMigrationCommands } from '../src/clickhouse/migration';

/**
 * Newton fork: data-skipping index on properties['eventName'].
 *
 * Koyo-style telemetry sends every event as name='log' (62M+ rows) with the
 * real event name in properties.eventName, so name-based pruning never helps
 * those queries. Filtering on properties['eventName'] must then decompress the
 * entire properties Map for every candidate row — a full-retention filter read
 * 1.35B rows / 528 GiB in ~176s on the analytics replica, and the events page's
 * lookback expansion re-ran that class of scan up to 11× per page view.
 *
 * A bloom_filter index on the map element lets granule pruning skip parts that
 * can't contain the value (same pattern as the existing idx_properties_bounce
 * set index). Rare values collapse to a handful of granules; frequent values
 * are unchanged. Skip indexes can only over-read, never alter results.
 *
 * This migration only ADDs the index (cheap, metadata-level, idempotent) so new
 * parts index on insert/merge. Existing parts need MATERIALIZE INDEX — a heavy
 * one-time mutation over the fat properties column, kept OUT of the migration
 * and run manually partition-by-partition for control. See the companion
 * `22-eventname-bloom-index.admin.sql` runbook (pilot one partition, measure,
 * then roll the rest). Fresh installs need no backfill.
 */

const DB = 'openpanel';

export async function up() {
  const sqls = [
    `ALTER TABLE ${DB}.events ADD INDEX IF NOT EXISTS idx_properties_event_name properties['eventName'] TYPE bloom_filter(0.01) GRANULARITY 1`,
  ];

  fs.writeFileSync(
    path.join(import.meta.filename.replace('.ts', '.sql')),
    sqls.map((sql) => sql.trim().replace(/;$/, '').concat(';')).join('\n\n---\n\n')
  );

  if (!process.argv.includes('--dry')) {
    await runClickhouseMigrationCommands(sqls);
  }
}

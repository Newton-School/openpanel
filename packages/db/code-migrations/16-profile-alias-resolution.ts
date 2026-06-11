import fs from 'node:fs';
import path from 'node:path';
import { runClickhouseMigrationCommands } from '../src/clickhouse/migration';

/**
 * Query-time anonymous -> identified profile resolution (Newton fork) — VIEW only.
 *
 * This migration creates ONLY the read-side `events_resolved` view, because it
 * is the one object creatable by the migration's service user. The other two
 * objects are a one-time ADMIN step — see the companion
 * `16-profile-alias-resolution.admin.sql`, run as the ClickHouse Cloud
 * `default` user — because (verified on prod Cloud):
 *   1. The `device_alias` dictionary can only be created by `default`: a
 *      non-default user's CLICKHOUSE dict source demands explicit credentials,
 *      and ClickHouse docs say to create dictionaries as `default` on Cloud.
 *   2. `profile_aliases` must be reshaped to ReplacingMergeTree ORDER BY
 *      (project_id, alias) so dictionary cache-miss lookups hit the primary key;
 *      it is dependency-coupled to the dict (dict SOURCE reads it), so the two
 *      live together in the admin runbook.
 *
 * Per-environment order: run the admin runbook (table + dict + grant) as
 * `default`, then this migration (view), then enable NEWTON_RESOLVE_PROFILE.
 *
 * Resolution semantics (validated live): the view swaps `profile_id` for the
 * dictionary's uid; a cookie with no/ambiguous alias falls back to its raw
 * value (stays anonymous), and 32-char IP+UA hashes never enter the dict so are
 * never merged.
 */

const DB = 'openpanel';

export async function up() {
  const sqls = [
    `CREATE OR REPLACE VIEW ${DB}.events_resolved AS
    SELECT
      * EXCEPT (profile_id),
      dictGetOrDefault('${DB}.device_alias', 'profile_id', (project_id, profile_id), profile_id) AS profile_id
    FROM ${DB}.events`,
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
    `DROP VIEW IF EXISTS ${DB}.events_resolved`,
  ]);
}

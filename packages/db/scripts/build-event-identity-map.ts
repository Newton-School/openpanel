/**
 * build-event-identity-map
 * ------------------------
 * Events carry only email ($user_id) and username (distinct_id / currentUserIdentifier),
 * never the newton uid. To set OpenPanel profile_id = uid on migrated events we need a
 * COMPLETE email->uid + username->uid map for ALL migrated users (the 177K gap map only
 * covered no-userId profiles). This builds that map from the parked PROFILES export,
 * reusing the same uid-resolution the profile loader used.
 *
 * Prep (same S3 inputs as the profile loader):
 *   aws s3 sync s3://newton-mixpanel-migration/newton-school/profiles/ /data/profiles/
 *   aws s3 cp   s3://newton-mixpanel-migration/identity/newton-school/mixpanel_email_uid.json /data/gap.json
 * Run:
 *   pnpm jiti ./scripts/build-event-identity-map.ts --dir /data/profiles --gap /data/gap.json --out /data/event_identity.json
 * Then upload /data/event_identity.json to s3://.../identity/newton-school/event_identity.json
 *
 * Output JSON: { "<lowercased email>": "<uid>", "u:<username>": "<uid>", ... }
 * (same key convention as the gap map, so the events loader uses one lookup.)
 */
import { createReadStream } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { parseArgs } from 'node:util';
import { createGunzip } from 'node:zlib';

const { values } = parseArgs({
  options: {
    dir: { type: 'string' },
    gap: { type: 'string' },
    out: { type: 'string', default: '/data/event_identity.json' },
  },
  strict: true,
});
if (!values.dir || !values.gap) {
  console.error('required: --dir <profiles dir> --gap <gap.json> [--out path]');
  process.exit(1);
}

type Props = Record<string, unknown>;
const firstStr = (p: Props, ...keys: string[]): string => {
  for (const k of keys) {
    const v = p[k];
    if (typeof v === 'string' && v !== '') return v;
  }
  return '';
};

// Same resolution the profile loader used: userId on the profile, else gap map.
function resolveUid(props: Props, gap: Map<string, string>): string {
  const own = props.userId;
  if (typeof own === 'string' && own !== '') return own;
  const email = firstStr(props, '$email', 'email');
  if (email) {
    const hit = gap.get(email.trim().toLowerCase());
    if (hit) return hit;
  }
  const uname = firstStr(props, '$username', 'username');
  if (uname) {
    const hit = gap.get(`u:${uname}`);
    if (hit) return hit;
  }
  return '';
}

async function main() {
  const { readdir } = await import('node:fs/promises');
  console.log(`[gap] loading ${values.gap}`);
  const gap = new Map<string, string>(
    Object.entries(JSON.parse(await readFile(values.gap!, 'utf8')) as Record<string, string>),
  );
  console.log(`[gap] ${gap.size} entries`);

  const files = (await readdir(values.dir!))
    .filter((f) => f.startsWith('page-') && f.endsWith('.jsonl.gz'))
    .sort();
  console.log(`[scan] ${files.length} profile pages`);

  const map: Record<string, string> = {};
  let total = 0;
  let resolved = 0;
  let emailKeys = 0;
  let userKeys = 0;

  for (const f of files) {
    const rl = createInterface({
      input: createReadStream(`${values.dir}/${f}`).pipe(createGunzip()),
      crlfDelay: Number.POSITIVE_INFINITY,
    });
    for await (const line of rl) {
      if (!line) continue;
      total++;
      let rec: { $properties?: Props };
      try {
        rec = JSON.parse(line);
      } catch {
        continue;
      }
      const props = rec.$properties;
      if (!props) continue;
      const uid = resolveUid(props, gap);
      if (!uid) continue;
      resolved++;
      const email = firstStr(props, '$email', 'email').trim().toLowerCase();
      const uname = firstStr(props, '$username', 'username');
      if (email && !(email in map)) {
        map[email] = uid;
        emailKeys++;
      }
      if (uname && !(`u:${uname}` in map)) {
        map[`u:${uname}`] = uid;
        userKeys++;
      }
    }
    console.log(`[scan] ${f} total=${total} resolved=${resolved} mapKeys=${emailKeys + userKeys}`);
  }

  console.log(`[write] ${values.out} (email keys=${emailKeys}, username keys=${userKeys}, total=${emailKeys + userKeys})`);
  await writeFile(values.out!, JSON.stringify(map));
  console.log(`[DONE] profiles=${total} resolved=${resolved} map_entries=${emailKeys + userKeys}`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });

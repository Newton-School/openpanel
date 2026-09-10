## Had to install these locally

# Install deps (workspace + db package)
pnpm add -w -D jiti
pnpm add -w -D prisma
pnpm add -w -D dotenv-cli
pnpm add -D prisma -F db
pnpm add @prisma/client -F db
pnpm add -D prisma-json-types-generator -F db

## Newton fork settings

Environment variables added by the fork. All optional; see `.env.example`
for defaults and which pod reads each one.

| Variable | Read by | Default | Purpose |
|---|---|---|---|
| `VIEW_USERS_EXPORT_LIMIT` | api | 10000 | Max users in a "View Users" CSV export (funnel step or chart point). The on-screen list stays at 1,000. |
| `COHORT_MATERIALIZE_LIMIT` | worker, api | 10000 | Max members stored per cohort compute. Worker heap is ~250-300MB per 1M members. Set on both pods. |
| `COHORT_QUERY_SPILL_BYTES` | worker, api | 314572800 | GROUP BY spill threshold for property cohorts. |
| `NEWTON_RESOLVE_PROFILE` | api, worker | unset | `1` reads windowed aggregations through `events_resolved` (anonymous -> identified folding). |
| `NEWTON_FUNNEL_STRICT_INCREASE` | api | unset | `1` restores strict step ordering in funnels (default matches Mixpanel's non-strict). |

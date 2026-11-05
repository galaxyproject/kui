# Implementation reference

This reference is for developers and agents. Start with the
[architecture overview](architecture.md) for the purpose and data flow.

## Stack, registry, and snapshots

KUI uses Astro, Vue, Tailwind CSS, and ECharts. The repository's `package.json`,
lockfile, and `.nvmrc` define the toolchain.

`servers.yml`.
The repository's `package.json`, lockfile, and `.nvmrc` define the toolchain.

```text
Galaxy → gxadmin → collector/kui.sh → per-site BigQuery aggregate tables
  → scripts/fetch-data.mjs → committed JSON → Astro build → GitHub Pages
```

`servers.yml` defines server identities, display colors, and exact table names.
Table names are never derived: org uses `users`, `jobs`, and `usage-us`.
Other registry entries may omit unpopulated data families.

The fetch script explicitly selects known columns from each registered table
and merges them into ascending monthly records. Missing months and families
remain null. Each server has a JSON snapshot; `index.json` records first/latest
months and row counts. Builds and frontend contributions need no GCP access.

Snapshots currently use schema version 1 and contain `server`, `generatedAt`,
and `months`. Each month contains nullable `users`, `jobs`, and `usage` groups.
See `src/lib/types.ts` and `src/lib/schema.ts` for the authoritative fields.
Changing the collection schema requires coordinated changes to collector table
schemas, fetch columns, validation, types, consumers, and fixtures.

## Frontend boundaries

- `src/pages/index.astro` loads the network inputs.
- `src/pages/[server]/index.astro` generates a page for each registered server.
- Each page has one Vue dashboard island using `client:load`; its date range
  drives all cards and charts. `useMonthRange.ts` reads and updates URL parameters.
- `metrics.ts` holds pure metric calculations. `aggregate.ts` aligns server
  series and calculates cross-server figures. These calculations depend on the
  selected range and run in the dashboard.
- `ClientChart.vue` imports ECharts and its Vue renderer after mount. Keep DOM
  dependencies out of server rendering. Preserve callers' chart heights; adding
  `h-full` to the wrapper can trigger a grow/measure autoresize loop.
- `src/styles/global.css` defines Galaxy design tokens and shared utilities.
  Fonts are self-hosted under `public/fonts/`.
- Internal links use `withBase()` from `src/lib/paths.ts`. The custom domain
  `https://kui.galaxyproject.org/` uses base `/`; keep the helper so links and
  fonts continue to respect the configured base.

## Data semantics

Missing values remain null. Averages skip nulls; ratios with absent inputs or
zero denominators are unavailable. Counter deltas and moving averages use the
full history before the displayed range is selected. Missing months must remain
visible, and negative counter changes must not be clamped away.

The one- and two-year presets select inclusive spans of 13 and 25 months.
Year-over-year comparisons therefore include matching calendar endpoints.
The current per-server dashboard combines registrations, engagement, service
usage, and jobs. Service usage leads with counter changes; tool installs remain
an absolute observation-time count.

Current aggregate headlines sum each server's latest available value inside
the selected range. They disclose missing servers and differing contribution
months; they are not common-cutoff totals. Metric and date definitions must
remain explicit when changing this behavior.

## gxrdb integration

gxadmin remains mandatory for database extraction. Extend its queries and
versioned exports, then extend `collector/kui.sh` to upload observations into
per-site BigQuery intake. gxrdb will retain raw source observations, produce
validated facts and monthly summaries, and expose reviewed public aggregates.
KUI will continue to build from committed JSON snapshots of those aggregates.

Raw job/metric tables are private. Public snapshots contain dashboard summaries,
not job or account records. Normalization runs centrally and can be replayed
without source extraction. Collection begins before consumed-CPU normalization
is solved; allocated core-hours does not depend on that work.

The first job/metric slice has a gxadmin exporter, an opt-in durable collector,
central acceptance and private allocated-core-hour facts. The org-only development
environment and manual processing workflow are described in
[gxrdb development operations](gxrdb-operations.md). Normal monthly collection and
the public fetch script still use legacy monthly aggregate tables. Migrate indicators individually,
retaining existing sources until replacement definitions, coverage, and counts
are validated.
The planned metric contracts are described in [metrics.md](metrics.md).
The source bundle contract for initial implementation is specified in
[gxrdb-export-contract.md](gxrdb-export-contract.md).

Operational setup and release checks are in [operations.md](operations.md).

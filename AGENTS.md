# Project guidance

## Purpose and context

KUI (Key Usage Indicators) provides public, manager-level monthly usage
dashboards for usegalaxy.* servers. The current app replaces Looker Studio
with a static Astro site. gxrdb is the proposed private operational data store
that will eventually supply validated indicators to KUI.

Read these local planning documents, in order, when working on the datastore:

1. `ea-no-commit/datastore-planning/KUIv2_plan.md`
2. `ea-no-commit/datastore-planning/gxrdb_plan.md`

These files are ignored local context and may be absent from other checkouts.
They contain design intent and historical evidence, not proof of current
implementation or production state. Check the actual code before applying a
plan. Keep private planning material and probe outputs out of public artifacts.

## Current implementation

- The root is an Astro 7 / Vue 3 / TypeScript project, using Tailwind CSS 4,
  ECharts 6 through `vue-echarts`, Zod 4, and Vitest 4. Use npm and retain
  `package-lock.json`.
- `collector/kui.sh` runs at each site, queries Galaxy through gxadmin, and
  writes monthly users/jobs/usage aggregates to that site's BigQuery tables.
  Configuration comes from `KUI_CONFIG` or adjacent `kui.conf`; see
  `collector/kui.conf.sample`. Service-account activation is supported and
  BigQuery metadata access is checked before source queries.
- `servers.yml` is the registry, with explicit table names. Do not derive
  table names from server IDs: org uses `users`, `jobs`, and `usage-us`.
- `scripts/fetch-data.mjs` reads BigQuery into public JSON snapshots in
  `data/snapshots/`, including `index.json`. It fills missing months with null
  data families. `--server <id>` refreshes one snapshot without updating the
  manifest; `--dry-run` still queries BigQuery.
- The site builds from snapshots without GCP credentials. `src/pages/index.astro`
  renders the aggregate page; `src/pages/[server]/index.astro` generates pages
  from the registry. Each page has one `client:load` Vue dashboard island.
- Derived metrics live in `src/lib/metrics.ts`; cross-server calculations are
  in `src/lib/aggregate.ts`. Snapshot types and Zod schemas live in
  `src/lib/types.ts` and `src/lib/schema.ts`.
- The per-server dashboard currently has four sections: registrations,
  engagement, service usage, and jobs. It uses new/returning job cohorts,
  usage-counter deltas, year-over-year comparisons, and 12-month trend lines.
  The tools card remains an absolute count.
- gxrdb's exporter, bundle acceptance protocol, canonical facts, and central
  transforms are not implemented here. Do not assume proposed paths such as
  `collector/gxrdb-export.sh` exist. Planned onboarding scripts and `docs/`
  pages are also absent. Legacy `run_queries.py`, `print_queries.py`, and
  `sql/` still exist locally; inspect before changing or removing them.

## Commands and verification

`package.json` declares Node >=22.12; CI uses Node 24. The installed jsdom 30
requires a newer Node 24 patch (>=24.15) for its supported runtime. Prefer a
Node version satisfying the full dependency tree.

```sh
npm ci
npm run dev                 # http://localhost:4321/kui/
npm run validate-snapshots  # registry and snapshot validation
npm test                    # src/**/*.test.ts, including DOM tooltip tests
npm run check               # Astro / TypeScript diagnostics
npm run build               # static output in dist/
npm run preview
```

CI runs snapshot validation, tests, checks, and build. Run the relevant checks
for a change and report failures accurately. For frontend changes, inspect
rendered pages at the `/kui/` base path, including a per-server page and the
aggregate page. Build output alone does not verify chart layout or interaction.

Dependency setup (2026-11-04): the existing installation lacked Rolldown's
macOS ARM64 binding. Install the platform binding matching the locked Rolldown
version (`@rolldown/binding-darwin-arm64@1.2.4` at initialization), or restore
optional dependencies with `npm ci`. The WASM binding mentioned in the final
startup error was a fallback, not the required native package. Do not delete
the lockfile or add a platform-specific direct dependency as an automatic remedy.

## Site and metric conventions

- Use `withBase()` in `src/lib/paths.ts` for internal links. Deployment uses
  `https://galaxyproject.github.io/kui/`, configured in `astro.config.mjs`.
- Preserve the Galaxy design tokens in `src/styles/global.css`, self-hosted
  Atkinson Hyperlegible fonts, and existing card/chart components.
- Keep browser-dependent chart imports behind `ClientChart.vue`'s mount-time
  loading. Preserve explicit chart heights; its wrapper must not acquire
  `h-full`, which can cause an autoresize growth loop.
- Keep raw snapshot fields distinct from derived metrics. Coordinate schema
  changes across collector schemas, fetch columns, TypeScript types, Zod
  schemas, consumers, and fixtures.
- Missing is null, not zero. Means skip nulls; undefined ratios stay null.
  Preserve gaps and negative counter deltas. Compute deltas and rolling trends
  over full history before selecting the displayed range.
- Date presets use inclusive year spans: one year is 13 months, two years is
  25. `useMonthRange.ts` shares the range and mirrors it to URL query parameters.
- Aggregate headline totals currently use each site's latest present value
  within the range and disclose mixed months and missing sites. Do not describe
  them as common-cutoff totals.
- Historical tools counts cannot be reconstructed from today's tools API.
  Looker averages and job-share calculations are not unquestioned parity targets.
  Make metric-definition changes explicit and test their intended meaning.

## gxrdb direction and correctness requirements

When implementing datastore work, preserve the plan's core boundaries:

- gxadmin owns source SQL and Galaxy-schema compatibility; the site collector
  owns bounded extraction, durable spool/checkpoints, retries, and uploads.
  Central processing owns normalization, trust, coverage, and publication.
- No site daemon or local analytical database. Use bounded read-only extraction,
  finite timeouts, one reader, explicit source/disk budgets, and durable state.
  Existing probe scripts are diagnostic evidence, not production exporters.
- Discovery, pending-job refresh, and reconciliation are separate queues.
  ID watermarks and overlap do not prove completeness. The proposed job floor
  is 2026-01-01 UTC; lower-ID verification is required before claiming coverage.
- Export coherent versioned bundles from one bounded source snapshot. Publish
  only complete centrally accepted bundles; `bq load` does not upsert or make
  multiple component loads atomic. Retries must be idempotent, delayed older
  observations must not overwrite newer ones, and empty child snapshots must
  replace stale children.
- Preserve source identity, observation generations, provenance, coverage, and
  corrections. Source IDs are site/epoch scoped INT64 values; never pass them
  through JavaScript floating-point numbers.
- Export only approved fields and `(plugin, metric_name)` pairs. Private job
  data must not enter public KUI snapshots. Default text-metric allow-list is
  empty; exclude identifying/free-text payloads specified in the plan.
- Distinguish allocated core-hours from consumed CPU. Keep metric presence and
  CPU/memory/OOM trust separate. `memory.failcnt` is not an OOM-kill count;
  declared slots are not necessarily an enforced CPU limit. Preserve conflicting
  metrics and missing values rather than choosing an arbitrary maximum or zero.
- Define collection traversal, distinct-dataset grain, and observed-size
  completeness before claiming input/output totals. Preserve unresolved references.
- Migrate KUI indicator by indicator after coverage and parity validation;
  retain legacy user/usage/tool sources until their replacements pass. The
  plan requires two monthly shadow publication cycles and per-site rollback.
  Job facts alone cannot replace lifetime totals or all KUI metrics.

## Workflow and publication

- Work on `main` for this project, as explicitly requested on 2026-11-04.
  Use branches rather than worktrees if a later task calls for isolation.
  Preserve existing uncommitted work; initial
  inspection found extensive local KUI v2 changes on top of legacy history.
  Do not stage, revert, or commit unrelated changes.
- Always obtain explicit user permission before any GitHub push, including a
  fork branch that creates or updates a PR targeting `galaxyproject`. Prepare
  and validate concrete local changes before asking. A general implementation
  request does not authorize pushing or publishing PR changes.
- Obtain explicit permission before creating a repository fork.
- Prefer `gh` for GitHub interactions. Use `--body-file` for multiline text.
  If sandboxed `gh` reports an invalid token or HTTP 401, retry the intended
  command with `sandbox_permissions: require_escalated` before concluding auth
  is broken or switching to the browser. Verify authorized writes by reading
  the resulting resource with `gh`. This does not waive publishing approvals.
- Snapshot refreshes and collector runs access live systems; do not run them as
  ordinary frontend checks. The existing refresh workflow writes commits to
  main and can open failure issues. Local initialization does not authorize
  dispatching it, changing IAM, provisioning cloud resources, or deploying.
- Treat ea-dev changes as validation and record permanent fixes upstream. For
  Galaxy deployment work, prefer reusable Galaxy Helm chart behavior over
  AnVIL-specific k8s-boot logic; shared reference data belongs in IDC/CVMFS.

# Key Usage Indicators (KUI)

The Key Usage Indicators dashboard summarizes monthly usage of usegalaxy.*
Galaxy servers: user registrations, engagement, service usage, and jobs. It is
published as a static site at [gxy.io/kui](https://gxy.io/kui).

Two halves live in this repository:

- **`collector/`** — `kui.sh`, run monthly by each server's admin, writes one
  row per month into that server's BigQuery tables.
- **the site** — an Astro + Vue app that renders committed JSON snapshots of
  those tables. No database access is needed to build or contribute to it.

```
Galaxy servers ──kui.sh (cron, 1st)──▶ BigQuery per-server tables
                                            │
GitHub Action (cron, 3rd) ──fetch-data──────┘
  └─▶ commits JSON snapshots ─▶ Astro build ─▶ GitHub Pages
```

## Working on the site

Use the Node version in `.nvmrc` (`nvm install && nvm use`), or another
supported version listed in `package.json`.

```bash
npm ci
npm run dev        # http://localhost:4321/kui/
npm run build      # static output in dist/
npm test           # metrics + aggregate unit tests
npm run check      # astro/TypeScript diagnostics
```

Snapshots in `data/snapshots/` are committed, so all of the above works without
any Google Cloud credentials.

### Layout

| Path | Purpose |
| --- | --- |
| `servers.yml` | Server registry — the single source of truth for which servers exist and which BigQuery tables hold their data. |
| `data/snapshots/` | Committed JSON per server plus an `index.json` manifest. |
| `src/lib/metrics.ts` | Derived metrics (averages, percentages, job-share split). Pure and unit-tested. |
| `src/lib/aggregate.ts` | Cross-server month axis, per-server series, headline totals. |
| `src/components/` | Astro shell, Vue dashboards, cards, ECharts wrappers. |
| `scripts/fetch-data.mjs` | Reads BigQuery and rewrites the snapshots. |

Derived metrics are computed in the browser rather than baked into the
snapshots, because they depend on the date range the visitor selects.

### Refreshing the data

```bash
gcloud auth application-default login   # once
npm run fetch-data                       # all servers
npm run fetch-data -- --server usegalaxy-eu
npm run validate-snapshots
```

In CI this runs monthly from `.github/workflows/refresh-data.yml`,
authenticating to BigQuery through Workload Identity Federation, and commits the
result — every refresh is a reviewable diff.

### Adding a server

1. Have the project owner create the three BigQuery tables (schemas in
   `collector/schemas/`) and a service account scoped to just those tables:

   ```bash
   SITE=xx; PROJECT=anvil-cost-modeling
   SA_EMAIL="kui-${SITE}@${PROJECT}.iam.gserviceaccount.com"

   gcloud iam service-accounts create "kui-${SITE}" --project="$PROJECT" \
     --display-name="KUI collector for usegalaxy.${SITE}"

   # Write access to this site's three tables only
   for t in "users-${SITE}" "jobs-${SITE}" "usage-${SITE}"; do
     bq add-iam-policy-binding --member="serviceAccount:${SA_EMAIL}" \
       --role=roles/bigquery.dataEditor "${PROJECT}:kui.${t}"
   done

   # Running a query job needs one project-level role
   gcloud projects add-iam-policy-binding "$PROJECT" \
     --member="serviceAccount:${SA_EMAIL}" --role=roles/bigquery.jobUser

   gcloud iam service-accounts keys create "kui-${SITE}.json" \
     --iam-account="$SA_EMAIL"
   ```

   Send the key to the site admin over a private channel. One account per site
   keeps the existing isolation: a key can be revoked without affecting anyone
   else, and it can only write that site's tables.
2. The admin installs the collector (below) and backfills history.
3. Open a PR adding an entry to `servers.yml` with the exact table names.
4. After merge, dispatch the refresh workflow; the new page appears at
   `/kui/<server-id>/`.

## Running the collector

Requires [`gxadmin`](https://github.com/galaxyproject/gxadmin),
[`jq`](https://jqlang.github.io/jq/), and
[google-cloud-sdk](https://cloud.google.com/sdk/docs/install).

You will be issued a **service account key** when your server is onboarded.
Install it, point the config at it, and no one ever has to be logged in:

```bash
sudo install -d -m 750 -o galaxy -g galaxy /etc/kui
sudo install -m 600 -o galaxy -g galaxy kui-xx.json /etc/kui/kui-sa.json

cp collector/kui.conf.sample collector/kui.conf
$EDITOR collector/kui.conf    # table names, galaxy_server, PGDATABASE,
                              # SERVICE_ACCOUNT_KEY, CLOUDSDK_CONFIG
./collector/kui.sh [YYYY] [MM]          # defaults to the previous month
```

`kui.sh` re-activates the service account on every run and checks BigQuery is
reachable before touching the Galaxy database, so a failure is reported in
seconds rather than after twenty minutes of queries.

**Why a service account rather than `gcloud auth login`.** A user login is an
interactive session that expires, gets revoked, or lives in a credential cache
tied to one person's `$HOME` — which is why sites have had to re-authenticate
after a reboot. A service account key is a file on disk with no session behind
it. If the credential cache is wiped, the next run re-creates it from the key.

If your cron job runs as a different user from your interactive shell, also set
`CLOUDSDK_CONFIG` (see `kui.conf.sample`). gcloud writing to one credential
directory and reading from another is the usual reason a collector works by hand
and fails from cron.

`kui.sh` refuses to run without a config file, so an unconfigured install can no
longer write to the shared `-dev` tables. Settings live in `kui.conf` and not
in the script, so `git pull` never conflicts with local edits.

Backfill by looping over months, then add a cron entry:

```bash
0 1 1 * * /path/to/collector/kui.sh >> ~/kui_logs/kui-run-logs-$(date +\%Y\%m).log
```

## Deployment

GitHub Pages, built by `.github/workflows/deploy.yml` on every push to `main`
that touches the site or its data. The site is served under `/kui`, so all
internal links go through `withBase()` in `src/lib/paths.ts`.

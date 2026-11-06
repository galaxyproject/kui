# Collection, refresh, and deployment

## Local verification

Use the Node version in `.nvmrc`. With nvm installed:

```sh
nvm install
nvm use
npm ci
npm run validate-snapshots
npm test
npm run check
npm run build
npm run preview
```

Verify `/` and a per-server path such as `/usegalaxy-org/`. Check charts,
date controls, responsive layout, and missing-data states in a browser. Builds
use committed snapshots and do not require GCP credentials.

The CI workflow runs snapshot validation, tests, Astro checks, and the build
on pull requests or manual dispatch. There is no requirement to contact a live
Galaxy database for frontend checks.

All workflows select the organization's `gcp-runner` label, matching
`galaxy-k8s-boot`. CI explicitly installs Node from `.nvmrc` and Python 3.12 for
the collector tests. Runner access is managed by the organization; selecting the
label does not register a new runner.

## Site collector

Installation and per-site onboarding are described in the [README](../README.md).
The collector requires gxadmin, jq, and the Google Cloud CLI. It uses GNU
`date -d`; run it on the Linux collection host or provide the GNU utility.

Settings come from `KUI_CONFIG` or `collector/kui.conf`. The script refuses to
run without configuration and checks required destination fields. When
`SERVICE_ACCOUNT_KEY` is set, it activates that identity each run and exports
the credentials for Google client libraries. It checks users-table metadata
access before querying Galaxy. Pin `CLOUDSDK_CONFIG` to a directory writable
by the cron user when its environment differs from the interactive shell.

Keep credentials and local configuration private. Site identities should write
only their assigned tables; query execution also requires project-level job
creation permission. New gxrdb intake tables need explicit provisioning and
permissions; access to legacy aggregate tables does not automatically extend.

Collection normally runs on the first of each month for the previous month.
Database extraction must use gxadmin; corrections and additional query/export
capabilities belong there. Queries run asynchronously. Preserve failure
reporting, source-load safeguards, and safe replay as collection expands.

## Refreshing public snapshots

`scripts/fetch-data.mjs` uses Google Application Default Credentials and reads
explicit registry tables in BigQuery's US location. Local commands:

```sh
gcloud auth application-default login
npm run fetch-data
npm run validate-snapshots
```

`--server <id>` refreshes only that server file and leaves `index.json`
unchanged. `--dry-run` avoids writing files but still performs live queries.
The script exits nonzero when a table read fails and warns about sites behind
the latest reporting month. It can write server files before reporting a later
read failure; inspect and validate outputs before publishing a refresh.

The refresh workflow runs at 06:00 UTC on the third of each month and supports
manual dispatch. It uses Workload Identity Federation with `WIF_PROVIDER` and
`WIF_SERVICE_ACCOUNT` repository secrets. Provision a reader with dataset read
access and query-job permission, restricting the federation provider to the
intended repository. The site collector's write identity is separate.

The workflow validates snapshots and commits substantive data changes to main;
timestamp-only changes are discarded. Its failure handler attempts to create
one open issue labeled `data-refresh`. Confirm the label exists and that the
workflow can create issues. Branch protection may require replacing direct
commits with a reviewed PR workflow.

Live refreshes, IAM changes, and workflow dispatches are operational actions,
not part of ordinary local verification.

## GitHub Pages

`astro.config.mjs` sets `site: https://kui.galaxyproject.org` and `base: /`.
The deploy workflow builds with `withastro/action@v6` and deploys using
`actions/deploy-pages@v4`. It runs on selected site/config/data changes pushed
to main and on manual dispatch. Deployments are serialized through the `pages`
concurrency group.

Repository Pages settings must use GitHub Actions, and the deployment job uses
the `github-pages` environment. Workflow files alone do not establish that the
live repository settings, federation, or public redirect are configured.

The custom domain is `kui.galaxyproject.org`. In the `galaxyproject.org` DNS
zone, add a CNAME named `kui` pointing to `galaxyproject.github.io.`. The target
is the organization hostname, with no repository path. Repository Pages settings
must also name this custom domain; an Actions deployment does not require a
CNAME file in the repository. After DNS validation and certificate issuance,
enable HTTPS enforcement in Pages settings. See
[GitHub's custom-domain instructions](https://docs.github.com/en/pages/configuring-a-custom-domain-for-your-github-pages-site/managing-a-custom-domain-for-your-github-pages-site).

Before a release or public cutover, verify:

1. The committed snapshots pass checks and render at the configured base path.
2. Refresh authentication and failure reporting work in the target repository.
3. A refresh produces the expected deployment. The refresh and deploy workflows
   have separate triggers; validate the complete chain, including automation
   token behavior, rather than assuming a bot commit launches another workflow.
4. The deployed aggregate and per-server pages show the expected data and dates.
5. The `gxy.io/kui` redirect points to the intended public dashboard when cutover
   is authorized. Suitable metric parity and an operational cutover are separate.

Do not infer production activation from a successful local build.

## gxrdb development pilot

The org-only development setup and manual central workflow are described in
[gxrdb development operations](gxrdb-operations.md). They use separate datasets
and identities; the current monthly collection and snapshot refresh continue
using their existing tables.

# gxrdb development operations

Start with the [architecture overview](architecture.md). The org-only development
pipeline accepts jobs and numeric metrics, retains their raw observations, and
builds private job facts and monthly allocated core-hours. Existing KUI collection
and public snapshots continue using their current tables. Production onboarding,
monthly collection queues and public indicator cutover are later steps.

## Configuration and ownership

`gxrdb/dev.json` names the project, region, datasets, source epoch, identities,
query-byte budget and maximum bundles per run. `GXRDB_CONFIG` selects another
configuration file. This pilot supports only `usegalaxy-org` and isolated
`gxrdb_dev*` datasets.

| Resource | Purpose |
| --- | --- |
| `gxrdb_dev_org_intake` | Component uploads and completion submissions |
| `gxrdb_dev` | Retained observations, receipts, quarantine, facts and publication bookkeeping |
| Org development service account | Load/read its intake; read its receipts |
| Central development service account | Read intake; write central tables; inspect load-job metadata |

Both datasets are private, with explicit cleanup and no automatic table/partition
expiry. Source IDs and generations are exact INT64s; raw numeric measurements
remain STRINGs. Component observations use ingestion-time partitions. Facts and
monthly summaries use creation-month partitions and require partition filters.
Schemas are generated with `node scripts/gxrdb/schema.mjs` from the shared
[export contract](gxrdb-export-contract.md).

## Provisioning and access checks

Use the maintainer's normal Google Cloud credentials, `gcloud`, Node and Google
Application Default Credentials. Never put credentials in configuration or Git.

```sh
npm ci
npm run gxrdb:plan
npm run gxrdb:provision
npm run gxrdb:verify-access
```

Provisioning reconciles the development accounts, schemas and explicit dataset
permissions, and allows the operator to impersonate the two accounts. It creates
no service-account keys and leaves legacy KUI resources alone. Additive schema
updates permit nullable suffix columns; incompatible existing schemas fail.

Independent verification of org's load jobs also requires a custom project role
containing only `bigquery.jobs.get`. Granting it is a separate explicit action:

```sh
node scripts/gxrdb/provision.mjs --apply --grant-load-inspector
```

This was approved for the central development account. It permits reading other
accounts' job metadata across the project, including query text; it provides no
table-read or IAM-management permission. The normal provisioning command does
not introduce this grant implicitly.

The access check uses short-lived impersonation of both development accounts.
It submits a header-only zero-row load, verifies central inspection of its
metadata, checks receipt access, and verifies denial of org reads/writes to
retained data and facts. Negative query checks are dry runs. It works with a
populated intake and does not accept bundles or run Galaxy queries. These are
live cloud checks, separate from routine CI.

The workload-identity provider restricts authentication to immutable GitHub
owner/repository IDs, `main`, and this repository's `gxrdb-process.yml` workflow.
The repository variables `GXRDB_WIF_PROVIDER` and `GXRDB_SERVICE_ACCOUNT` select
that provider and the central account. No other server identity is provisioned.

## Collector runtime and a bounded manual capture

The site needs a gxadmin build containing `galaxy export-job-observations`, psql,
Python 3, gcloud/bq and jq, Galaxy connection configuration, and a private writable
state directory. The exporter is developed in gxadmin; KUI contains no Galaxy SQL.
Check the running Galaxy application release (26.1 minimum) and the site's UTC
interpretation; recorded job versions do not establish the running release.

1. Copy `collector/gxrdb.conf.sample.json` to a private configuration file and
   set source identity, verified release, destination and absolute state path.
2. In `kui.conf`, set `GXRDB_ENABLED=true` and `GXRDB_COLLECTOR_CONFIG` to that
   file. Use the site's own intake identity through the normal gcloud setup.
3. Provide a bounded selection JSON, with IDs encoded as decimal strings:

```json
{"entity":"jobs","mode":"id_range","lowExclusive":"100","highInclusive":"200"}
```

```sh
KUI_CONFIG=/private/path/kui.conf ./collector/kui.sh --gxrdb-only selection.json
# Resume uploads and consume receipts without selecting new source data:
KUI_CONFIG=/private/path/kui.conf ./collector/kui.sh --gxrdb-only
```

The explicit mode does not require legacy monthly collector variables. Normal
monthly collection continues on its existing path; automatic discovery, pending
refresh and reconciliation queues follow in the monthly lifecycle step.

Defaults bound a run to 500 selected IDs, 16 MiB of source output, 256 MiB of local
spool, four unaccepted bundles, 50,000 pending jobs and ten minutes. gxadmin uses
one read-only repeatable-read transaction, finite query/lock timeouts, an output
budget. The collector holds a local exclusive lock to prevent overlapping
runs. State/spool directories must be private.

## Upload, acceptance and recovery

The collector saves a generation and UUID before extraction. gxadmin writes
`jobs.csv`, `numeric_metrics.csv` and `metadata.json` from one source snapshot.
Its format-version-1 interface contains Galaxy fields, schema capabilities,
selection, observed time, snapshot ID and the CSV null marker. It does not know
site identities, observation generations, gxrdb manifests or BigQuery.

The collector validates the source metadata and headers, adds the common
site/bundle/generation columns, and produces deterministic gzip parts,
checksums, the wire capability record and the v1 completion manifest. Payload
values remain strings throughout packaging; numeric counters and IDs are never
converted through floating point. `sourceFormatVersion` in the capability
record identifies the native export format. The receiver's wire contract is
unchanged. Completed files are immutable. Repeated upload attempts inspect the original deterministic load-job ID;
a new attempt ID is allowed only after a confirmed atomic load failure.

Component uploads are followed by a completion submission containing the source
manifest, capability record and load-job references. Central processing checks
manifest and capability compatibility, actual load owner/destination/options,
checksums in job labels, parsed counts, source keys, selection membership and
metric allow-lists. The checksum identifies the collector's immutable upload;
BigQuery metadata does not provide an independent digest of uploaded file bytes.
Partial uploads have no completion submission and cannot be accepted.

Acceptance copies all validated observations and provenance into central tables
and commits an acceptance record plus a read-only site receipt in one transaction.
Invalid submissions enter private quarantine. Transient API/infrastructure errors
remain retriable. Acceptance is separate from fact publication: accepted raw data
can be replayed if a later transformation fails.

A crash between extraction and packaging retains the completed source snapshot
under `source/`. The next run packages that exact snapshot without querying
Galaxy again. Source files are removed after the final bundle has been durably
written; receipt/checkpoint rules are unchanged. Old completed bundles remain
uploadable during this transition. Deploy the revised gxadmin and collector
together before selecting new data.

Only an accepted receipt matching both UUID and manifest hash advances the local
checkpoint and pending-job list. Receipt application follows generation order.
Accepted files are removed after the configured grace period; unaccepted and
rejected files are preserved. Disk exhaustion stops collection instead of dropping
unacknowledged data. A checkpoint records its accepted selection, not proof of
complete discovery or date coverage.

A rejected bundle stops automatic processing. After diagnosing and correcting the
cause, explicitly re-extract its selection with a fresh identity/generation:

```sh
python3 collector/gxrdb.py /private/path/gxrdb.json --retry-rejected BUNDLE_UUID
```

The old spool remains in `rejected/`. An interrupted rejection transition can be
resumed with the same command. Do not edit a completed bundle or delete state to
force a retry. A source-epoch change requires deliberate onboarding; it must not
be used to hide generation conflicts. Lost-state generation recovery consults
intake and receipts, but full discovery/pending reconstruction is later lifecycle
work. Retain the private state directory across routine deployments.

## Run central processing

The **Process gxrdb development data** workflow is manually dispatched after an
upload batch. There is no recurring trigger. For local validation using the
configured central account:

```sh
GXRDB_IMPERSONATE=kui-gxrdb-dev-central@anvil-cost-modeling.iam.gserviceaccount.com npm run gxrdb:process
```

Publishing workflow/code changes requires push approval. A local impersonated run
checks actual central permissions; a published Actions run also checks federation.

Facts choose the newest accepted generation covering each job. A newer empty
metric set replaces older children; an omitted job in an authoritative selection
becomes a tombstone. Corrections rebuild old and new creation-month slices.
Facts, summaries, revision records and the applied-bundle ledger commit together.
Replays and older delayed uploads cannot inflate totals or reverse newer data.

Allocated core-hours are runtime seconds times declared slots divided by 3,600.
Only present, non-copied, explicitly non-imported, execution-finished jobs
(`ok`, `error`, `deleted`) with usable core metrics contribute. Identical duplicate
values collapse; conflicting, null, invalid or missing values remain unknown.
Runtime zero is valid; slots must be a positive integer. Reopened jobs remain
pending even if old metrics persist. Declared slots do not establish an enforced
CPU limit. Memory allocation status is independent of allocated core-hours.

Raw cgroup counters remain exact and unresolved. CPU, memory and OOM presence
and trust are separate fields; no consumed-resource normalization is claimed.
All summaries remain `provisional` with `coverage_verified=false`. Bounded fixture
capture does not establish coverage from the proposed 2026 job floor. There is no
public snapshot export from these facts yet.

## Budgets, logs and tests

Every query is capped by the remaining per-run
[`maximumBytesBilled`](https://docs.cloud.google.com/bigquery/docs/reference/rest/v2/Job#jobconfigurationquery); billed bytes
are deducted even after failed queries. Unknown completion exhausts the remaining
budget. Central defaults to 1 GiB per run (small development transactions used
roughly 250–420 MiB), 120-second query timeouts and ten bundles. GitHub has a
ten-minute timeout and one processing run at a time. These are query-byte limits,
not a reservation or source-coverage guarantee.

Public logs contain statuses, run/bundle IDs, counts and billed bytes. Raw rows,
SQL-error bodies and credentials stay private. The workflow opens one issue per
unresolved failure streak with a link to the run. Check private quarantine and
receipts when diagnosing rejected data.

`npm run test:gxrdb` runs offline Node protocol/budget tests and Python collector
recovery tests. ea-dev fixtures and live failure-injection scripts are temporary
local development artifacts, outside this repository; they are not CI commands.

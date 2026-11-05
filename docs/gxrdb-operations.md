# gxrdb development operations

Start with the [architecture overview](architecture.md). This page covers the
org-only development pilot. Existing KUI collection and public snapshots continue
using their current tables.

## Scope and configuration

`gxrdb/dev.json` names the project, region, datasets, identities, byte budget and
GitHub repository. `GXRDB_CONFIG` can select another configuration file. The pilot
requires separate development datasets and supports only `usegalaxy-org`.

| Resource | Purpose |
| --- | --- |
| `gxrdb_dev_org_intake` | Org's component uploads and completion manifests |
| `gxrdb_dev` | Retained observations, acceptance records, org receipts, coverage, publications and processing runs |
| Org development service account | Load/read its intake; read its receipts |
| Central development service account | Read intake; write central tables |

These are private development resources. No other usegalaxy server is provisioned.
There is no automatic table or partition expiry: development cleanup is explicit,
so an old source observation cannot silently expire. Source capture and production
onboarding follow in later steps.

The versioned BigQuery schemas are in `schemas/gxrdb/bigquery-v1.json`, generated
from the export contract by `node scripts/gxrdb/schema.mjs`. Source INT64 values
remain BigQuery INTEGERs. Raw decimal metrics and JSON-array text remain STRINGs,
preserving their exact source representation. Component observations use
ingestion-time partitions; bookkeeping uses its recorded dates. Detailed
acceptance and canonical fact definitions are implemented in Slice A.

## Provisioning

Use the normal maintainer Google Cloud credentials; never put credentials in
configuration or source control. The provisioning command needs `gcloud`, Node,
and Google Application Default Credentials for the same human operator:

```sh
npm ci
npm run gxrdb:plan       # prints a plan; no cloud writes
npm run gxrdb:provision  # creates/reconciles the isolated development resources
```

Provisioning creates the two development service accounts, gives them query-job
permission in the configured project, and assigns dataset access explicitly.
It also allows the operator to impersonate these two accounts for validation.
It creates no service-account keys. Existing KUI datasets, collector accounts,
and snapshot-refresh authentication are not changed.

Org cannot read retained observations or modify central data. Its one central
read permission is the dedicated `org_receipts` table, which will contain only
org acceptance statuses. Central processing cannot modify the source intake.
Cross-server isolation testing is deferred until another server is onboarded.

The dedicated workload-identity provider checks immutable GitHub owner/repository
IDs, `refs/heads/main`, and the exact `gxrdb-process.yml` workflow path. The
service-account binding grants access through that provider's repository
attribute. This is separate from the existing snapshot-refresh identity. See
[Google's federation guidance](https://docs.cloud.google.com/iam/docs/workload-identity-federation-with-deployment-pipelines)
and [GitHub's OIDC claims](https://docs.github.com/en/actions/reference/security/oidc).

## Validate the development environment

```sh
npm run test:gxrdb
npm run gxrdb:verify-access
```

The access check uses short-lived impersonation of the actual development
accounts. It appends a header-only, zero-row load to org's jobs intake, checks
receipt access, and verifies that central reads/writes are denied to org.
Negative query checks use dry runs. It also executes the empty pipeline as the
central identity. No Galaxy server connection or source query is involved.

These checks make real Google Cloud requests. They are separate from routine
CI and frontend tests. The development manifests table must be empty.

## Run central processing

The workflow is manual: **Process gxrdb development data** in GitHub Actions.
There is no scheduled trigger in the pilot. Configure these repository variables
from the provisioning command's output:

- `GXRDB_WIF_PROVIDER`: full workload-identity provider resource name.
- `GXRDB_SERVICE_ACCOUNT`: central development service-account email.

The workflow file must first be published on `main`; obtain push approval before
publishing. Its job checks the repository and branch before authentication, and
Google independently enforces the identity-provider conditions.

For local validation as the central identity:

```sh
GXRDB_IMPERSONATE=kui-gxrdb-dev-central@anvil-cost-modeling.iam.gserviceaccount.com npm run gxrdb:process
```

Substitute the configured central email if using another project. Local
impersonation validates the central account's BigQuery permissions; the first
published Actions run separately validates GitHub-to-Google authentication.

At this stage processing checks table schemas, region and partitioning, counts
completion manifests, and writes a processing-run record. An empty intake
succeeds. If manifests exist, it records `blocked_unimplemented` and fails:
**it does not accept, acknowledge, transform or delete any bundle.** Slice A
will implement that behavior. Do not start source uploads expecting acceptance
until that implementation is ready.

## Budgets and failures

Every query has `maximumBytesBilled` set from the remaining per-run budget
(default 100 MiB). Billed bytes are deducted before the next query. Queries have
finite timeouts and workflow runs have a ten-minute limit; GitHub concurrency
allows one processing run at a time. See
[BigQuery query limits](https://docs.cloud.google.com/bigquery/docs/troubleshoot-queries).

Public workflow logs contain only run IDs, statuses, counts and billed bytes.
Raw rows and query-error payloads are never printed. On failure, the workflow
opens one issue per unresolved failure streak with a link to the run. Investigate
permission/schema failures before retrying; a pending-manifest failure requires
the Slice A receiver, not a larger query budget.

The empty workflow writes only `processing_runs`. It leaves receipts,
acceptance records, retained observations, coverage and publications untouched.

# gxrdb export contract v1

Status: **frozen v1 transport bundle contract**. The shared-snapshot
mechanism passed development tests on Galaxy 26.2/PostgreSQL 17.2 and
maintainer-run org validation on Galaxy 26.2/PostgreSQL 16.15, including 500 jobs
and 1,335 populated metric rows. Org retains database records; no cleanup-script
inspection is required. Wire changes discovered during implementation require
an explicit contract revision and compatible receiver/exporter changes.

The machine-readable definitions are
[`export-v1.json`](../schemas/gxrdb/export-v1.json) and
[`manifest-v1.schema.json`](../schemas/gxrdb/manifest-v1.schema.json).
They define the implementation interface, not commands or ingestion already available
in a released gxadmin/KUI deployment.

## Source compatibility and command boundaries

Galaxy 26.1 is the minimum supported release. Check the actual application
release and source schema before extracting; an old recorded job's
`galaxy_version` is not the running application's version. Older application
releases fail preflight. A missing optional observation on a supported release
is reported as unavailable rather than invented or silently dropped.

The gxadmin interface has three responsibilities:

1. Discover capabilities and the declared schema/allow-list versions.
2. Discover indexed source ID bounds for jobs/users.
3. Export a bounded range or explicit ID list as coherent source CSVs with
   snapshot metadata. gxadmin owns source queries and schema compatibility.
   The collector owns site/bundle/generation fields, gzip, checksums and the
   transport manifest defined here. Storage exports follow in a later slice.

Slice A implements `galaxy job-observation-capabilities`,
`galaxy job-observation-bounds` and `galaxy export-job-observations` in gxadmin.
They currently support the jobs/numeric-metrics scope. Remaining component
exports follow in later slices. Runner backend is read from
`job.job_runner_name`; `job.runner_name` is a different legacy field.

## Native gxadmin export and collector packaging

The native format-version-1 output is `jobs.csv`, `numeric_metrics.csv` and
`metadata.json`. CSV headers contain only the component fields from
`export-v1.json`, without the common envelope. Metadata records the selection,
CSV null marker, row counts, observation time, PostgreSQL snapshot ID and source
capabilities/build. Source numeric metrics remain unmodified decimal text.

The request contains `galaxyRelease`, verified `timestampInterpretation=UTC`,
`selection`, optional `csvNullMarker`, and row/output/time budgets. Capabilities
and bounds use `GXADMIN_GALAXY_RELEASE` and `GXADMIN_SOURCE_TIMEZONE`. A native
export does not use gxrdb identities or generate a transport manifest.

The collector reserves its identity/generation before extraction, passes its
per-bundle marker to gxadmin, then attaches the common envelope to every CSV
row. It derives the wire capability record (including `sourceFormatVersion`),
compresses the files, counts/checksums them and writes the frozen v1 manifest.
Repackaging the same native snapshot and persisted request yields the same wire
bytes. Native schema compatibility is checked before upload; receiver validation
of the transport bundle remains independent.

## Snapshot and selection

Use one `psql -X -v ON_ERROR_STOP=1` session with a bounded
`BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY` transaction for every component
in the selected job set. Set finite statement and lock timeouts. Close the
transaction before compression and upload. Do not run separate CSV commands
in independent database sessions and call their outputs a coherent snapshot.

ID ranges use `(lowExclusive, highInclusive]`; explicit lists use distinct IDs.
Bounds and IDs are validated INT64 values and passed safely. Empty ranges are
valid and can advance discovery after acceptance. User capture has its own
selection so pre-floor accounts can be collected. Storage is an observation,
not an ID-bounded reconstruction of historical month-end state.

Capture `observedAt` once for the source transaction and record its snapshot ID
as provenance. PostgreSQL snapshot IDs are not consumer revisions or global
ordering keys. The collector's persisted generation orders re-observations.
Job-time eligibility, floor verification, and period coverage remain explicit
central rules; a maximum ID alone does not establish complete date coverage.

## CSV and exact values

- Each component has the exact ordered header: common envelope columns, then
  its fields from `export-v1.json`. Unknown/missing/reordered columns fail
  validation; never use schema autodetection or tolerate bad rows.
- Use UTF-8 PostgreSQL CSV: comma delimiter, double-quote quoting/escaping,
  LF record terminators, and a header in every part. Quoted embedded newlines
  are valid; count records with a CSV parser rather than counting text lines.
- Use an explicit CSV null marker `__gxrdb_null_<bundle UUID>__`, recorded as
  `csvNullMarker` in the manifest and supplied to PostgreSQL COPY and BigQuery's
  `null_marker`. Empty STRING values remain empty. Reject a literal source field
  equal to the marker before finalization; quoting alone is not the collision
  policy. A fresh extraction identity can select a different marker. Enable
  quoted newlines and include null, empty, literal backslash-N, and marker-collision
  cases in the BigQuery round-trip tests before implementing acceptance. Do not
  assume PostgreSQL's default null/empty quoting is sufficient for BigQuery.
- Source IDs, generations, sizes, and counters are parsed exactly. JSON uses
  decimal strings for source selection IDs and generations. CSV INT64 values
  use base-10 integer text within signed INT64 bounds, never a floating-point
  intermediate. Count/byte-size manifest integers are bounded to exact JSON
  integers; the receiver enforces their semantic ranges as well.
- `decimal_text` stores the source numeric representation in a STRING landing
  column. ea-dev uses PostgreSQL `numeric(26,7)` for numeric metrics. Preserve
  all digits, duplicate rows, nulls, and source nonfinite values if present;
  canonical numeric conversion reports invalid/out-of-range values separately.
  Do not round or normalize raw source measurements during export.
- `utc_timestamp` means ISO 8601 UTC with `Z` and source precision. Galaxy's
  timestamp-without-time-zone fields require a verified UTC interpretation;
  changing a session timezone alone does not establish that interpretation.
- Booleans use PostgreSQL CSV `t`/`f`, with the declared marker for null. JSON-array
  text fields use valid JSON inside ordinary CSV quoting. Preserve a list-valued
  `dbkey` without reducing it arbitrarily to one value.

The schema's common row envelope supplies bundle ID, site, source epoch,
generation, and part index so uploaded rows can be associated with a component
and bundle. Metadata required to interpret the entire observation stays in the
manifest/capability record. Identity is independent of destination project and
dataset names; all GCP locations and destinations remain configurable.

BigQuery's [CSV load options](https://docs.cloud.google.com/bigquery/docs/loading-data-cloud-storage-csv#csv_options)
describe custom null markers and empty STRING handling. The actual load and
round-trip behavior must still be verified in the development dataset.

## Components and decoding

The first end-to-end slice requires `jobs` and `numeric_metrics`. The contract
also declares users, state history, dataset/collection relationships, dataset
features, approved numeric metadata, structured failure evidence, and storage.
Later slices implement those components without changing the meaning of raw
job/metric fields. Relationship direction/type and source row IDs preserve
multiplicity. Consumers must not join repeated child rows into job totals.

On the inspected modern Galaxy schema, metadata and `job_messages` are `bytea`,
not PostgreSQL JSON columns. Galaxy stores JSON-encoded bytes and can also read
legacy pickled dataset metadata. Source decoding belongs in gxadmin; a consumer
must not parse full Galaxy metadata documents or unpickle source payloads.

Export only the declared fields after safe decoding. Missing, invalid, unsupported
legacy encoding, absent metadata versions, and ambiguous default/sentinel values
have explicit statuses. Do not execute arbitrary pickle deserialization, cast
every historical blob to JSON unconditionally, or export an entire blob because
decoding was unavailable. A field's unsupported encoding does not make the
running Galaxy release unsupported. Capability discovery declares the decoder
and field-selection rules and per-observation status captures exceptions.

Input feature observations distinguish the requested input version from the
observed metadata version. Use retained matching historical metadata when
available; otherwise label current-instance features with unknown job-time
correspondence. Missing sizes and references do not disappear through inner
joins. `dbkey` unknown (`?`), absent values, and actual build labels remain distinct.

Numeric metrics use the explicit `(plugin, metric_name)` allow-list; text metrics
default to none. Metadata includes only `dbkey` and approved numeric counts.
Tool-specific reference/settings parameters, files, paths, free text, secrets,
and user contact details are outside this export contract. User IDs and account
flags remain private source data used by authorized gxrdb consumers.

For recorded structured job messages, selection is limited to
recognized message type, numeric error level, and numeric exit code when present.
Exclude descriptions, regex matches, stream contents, and environment-variable
names. Preserve unknown/unsupported message encodings or types as availability
exceptions. These fields are evidence for later interpretation; neither a message
severity nor exit code alone establishes a scheduler-enforced OOM kill.

## Completion manifest and acceptance

Finalize files and checksums before publishing the manifest. Each CSV part is
gzip-compressed without variable gzip timestamps; SHA-256 covers its exact
compressed bytes. Part names are safe basenames and indexes are unique and
contiguous within the component. Checksums identify retry files; the receiver
also validates load metadata, schemas, membership, and parsed record counts.

The intake completion row adds nullable `transport_json` alongside the unchanged
source `manifest_json`. It carries the exact capability JSON and deterministic
load-job references/attempts for each part. This is transport provenance, not a
change to source CSV fields or the frozen source manifest. Central processing
independently reads completed load-job metadata and validates destination,
account, options, declared checksum labels and output row counts. These labels
bind the collector's retry identity; BigQuery does not expose an independent
SHA-256 of uploaded bytes. Its `inputFileBytes` is not the compressed gzip size
and must not be compared to the manifest's `compressedBytes`.

`requestedComponents` identifies this bundle's scope. Every requested component
appears exactly once in the manifest. A complete empty component has one
header-only compressed part and zero records. An unsupported component has no
parts and a reason; it is neither an empty snapshot nor evidence of deletion.
Unrequested components are outside this bundle. Required unsupported components
fail preflight rather than producing an apparently successful slice.

Manifest schema validation is necessary but insufficient. The receiver also
checks INT64 limits, Galaxy release, component-set equality, part-name/component
matching, summed counts, envelope consistency, source-key uniqueness, selected-job
membership, capability compatibility, and whether required families are complete.
Multiple metric rows sharing a plugin/name are retained; duplicate source row
IDs within one component snapshot are a separate integrity error.

Bundle ID is an immutable UUID; `(serverId, sourceEpoch, observationGeneration)`
is unique and immutable. Persist the monotonically increasing generation before
extraction; validate immutable contents centrally. A re-extraction gets a new
identity and generation; retrying the same files retains both. Failed generations
can leave gaps. Never use upload arrival order or wall-clock time for freshness.

The source exporter writes no final completion signal after an error. Partial
files remain unacknowledged spool artifacts. The collector publishes a completion
manifest only after all component loads succeed. Durable central acceptance
follows validation and copying to centrally owned retained observations. The
collector advances its checkpoint only after that acceptance, not after a load
job, manifest submission, or fact-publication attempt.

The newest accepted observation replaces the corresponding supported child
snapshot, including explicit empty children. Unsupported/unrequested families
are not interpreted as deletion or silently presented as fresh older data.
Retain older observations with their dates/provenance under the retention policy.
Rebuild affected `(server_id, creation month)` slices, including prior and new
months for corrections, and publish facts/bookkeeping coherently. Replays and
out-of-order arrival must not duplicate totals or overwrite newer observations.

## Capabilities and validation gates

A capability record identifies application/schema versions, exporter build,
contract/component versions, ordered columns and types, source timestamp
interpretation, metric/metadata allow-lists, and supported/unsupported families
with reasons. Its deterministic JSON hash is referenced by the manifest.
Record feature availability separately from an absence of observations.

Step 1 freeze checks:

- [x] Prove a single read-only snapshot, concurrent-update isolation, exact
  CSV values, duplicate preservation, empty selections, and fail-fast behavior
  through gxadmin on ea-dev.
- [x] Validate org inventory, populated job/metric snapshots, traversal plans,
  and bounded timings through maintainer-run checks.
- [x] Reconcile the inspected source differences and freeze the component and
  manifest definitions for initial implementation.

The inspected source differences require no wire change: nullable account flags
and collection indexes are already representable, and absent observations remain
explicit gaps. The org sample's jobs record Galaxy 26.1, while its running
application is 26.2; this is not a test of a running 26.1 application. Core
resubmission metrics were absent from that sample and must not default to zero;
recorded state history is another source where available and complete.

Slice A validates BigQuery loading, acceptance and null/empty/quoted-value
round trips on ea-dev. Full
library/output-collection semantics and metadata decoding are implemented and
tested in Slice B. The global storage query received EXPLAIN only; full-query
timing remains part of the storage addition. None of these later gates is claimed
complete by the bounded Step 1 spike.

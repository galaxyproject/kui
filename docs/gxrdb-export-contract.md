# gxrdb export contract v1

The current development contract is defined in `schemas/gxrdb/export-v1.json`
and `manifest-v1.schema.json`. Galaxy 26.1 is the minimum recorded release;
gxadmin derives it from the latest version-bearing source job. Missing version
information or unsupported schemas fail extraction.

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

The native output is `jobs.csv`, `numeric_metrics.csv` and `metadata.json`.
Headers contain only component fields from `export-v1.json`. PostgreSQL's standard
CSV encoding represents null as an unquoted empty field and an empty string as
`""`. Metadata records selection, counts, observation time, PostgreSQL snapshot
and source capabilities. Raw metrics remain exact decimal text.

For a range, use `gxadmin galaxy export-job-observations LOW HIGH OUTPUT`.
For an explicit list or customized budgets, supply a request JSON and output
directory. Requests contain `selection`, optional `timestampInterpretation=UTC`,
and optional row/range/output/time limits. No declared Galaxy release is needed.

The collector reserves identity/generation, reads CSV with Python 3.13's
`QUOTE_NOTNULL`, adds the envelope and writes gzipped JSON Lines. JSON null,
empty strings and literal backslash-N remain distinct without collision markers.
IDs, generations and raw numeric values stay strings; booleans become JSON
booleans. A persisted source snapshot and request produce deterministic bytes.

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

## Serialization and exact values

Source CSV uses UTF-8, ordered headers, comma delimiters, double-quote escaping
and standard PostgreSQL null handling. Quoted embedded newlines are valid.
The collector checks source headers and counts once during packaging.

Transport components are `NAME-00000.jsonl.gz`, with the common envelope and
contract fields in each object. BigQuery loads use explicit schemas, no
autodetection, zero tolerated bad rows and append semantics. Source IDs,
generations and raw decimal values never pass through floating-point numbers.

The manifest records each component's count and compressed SHA-256. Load-job IDs
include bundle identity, component, part, attempt and file digest. The processor
checks manifest/capability identity, load owner/destination/schema, digest-bearing
job ID and loaded counts. A matching completed load is reused after response loss;
only a confirmed failed load permits a new attempt ID. BigQuery does not provide
an independent digest of local upload bytes.


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

Finalize files and checksums before publishing the manifest. Each JSON Lines part is
gzip-compressed without variable gzip timestamps; SHA-256 covers its exact
compressed bytes. Part names are safe basenames and indexes are unique and
contiguous within the component. Checksums identify retry files; the receiver
also validates load metadata, schemas, membership, and parsed record counts.

The intake completion row adds nullable `transport_json` alongside the
`manifest_json`. It carries the exact capability JSON and deterministic
load-job references/attempts for each part. This is transport provenance, not a
change to source CSV fields. Central processing
independently reads completed load-job metadata and validates destination,
account, options, checksum-bearing job IDs and output row counts. These IDs
bind the collector's retry identity; BigQuery does not expose an independent
SHA-256 of uploaded bytes. Its `inputFileBytes` is not the compressed gzip size
and must not be compared to the manifest's `compressedBytes`.

`requestedComponents` identifies this bundle's scope. Every requested component
appears exactly once in the manifest. A complete empty component has one
empty compressed part and zero records. An unsupported component has no
parts and a reason; it is neither an empty snapshot nor evidence of deletion.
Unrequested components are outside this bundle. Required unsupported components
fail preflight rather than producing an apparently successful slice.

Manifest schema validation is necessary but insufficient. The receiver also
checks INT64 limits, Galaxy release, component-set equality, part-name/component
matching, summed counts, envelope consistency, selected-job
membership, capability compatibility, and whether required families are complete.
Multiple metric rows sharing a plugin/name are retained; the highest source metric ID supplies the canonical value in facts.

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
library/output-collection semantics and metadata decoding will be implemented and
tested in Slice B. The global storage query received EXPLAIN only; full-query
timing remains part of the storage addition. None of these later gates is claimed
complete by the bounded Step 1 spike.

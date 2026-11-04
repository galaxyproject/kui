# Metric definitions and collection contracts

The existing snapshot schema is defined in `src/lib/schema.ts` and
`src/lib/types.ts`. The additions below are planned contracts; their queries,
tables, and dashboard fields are not yet implemented.

## Allocated core-hours

For eligible jobs created in a UTC month, sum core runtime in seconds multiplied
by declared Galaxy slots, then divide by 3600. Select metrics by plugin and name.
Collapse identical duplicates with provenance; conflicting observations require
an explicit resolution rule or an unavailable canonical value. Do not double
count copied/imported metrics as fresh compute.

The existing gxadmin `monthly-cpu-stats` query provides the starting allocation
calculation. Its current join selects metric names without qualifying plugins or
resolving duplicates. Extend it or the gxadmin export contract before relying on
it for the new metric. Verify machine-readable field order, nulls, numeric
precision, and failure behavior rather than parsing an assumed human table.

Allocated core-hours describes allocation over elapsed runtime, including idle
time. It does not establish consumed CPU or billing. Report usable-metric coverage
and distinguish jobs that never ran from executed jobs lacking observations.

## Raw job metrics and future normalization

gxadmin exports approved job fields and raw numeric metric observations;
`kui.sh` uploads them to BigQuery/gxrdb. Retain metric source row IDs, exact raw
values, plugin/name, job/source identity, placement, execution timestamps when
available, and collection/schema provenance. Preserve source observations when
canonical interpretations or units change. Do not convert source INT64 IDs
through JavaScript floating-point numbers.

Collection includes core allocation/runtime, cgroup CPU and memory counters,
and the node diagnostics required to evaluate those measurements. Export only
approved plugin/metric pairs. Keep job-level records private and exclude
identifying/free-text payloads.

Metric names provide candidate unit conventions, not evidence that every
destination and period follows them. Normalization must account for resource
replacement/reconfiguration, mixed populations, and counters that measure a
launcher or shared processes. Keep raw values, candidate factors, interpretation
rules, confidence, and validity periods separately. Ambiguous measurements remain
unavailable in trusted consumed-CPU totals. A utilization ratio uses matched jobs
for its consumed and allocated populations.

## Dataset storage

The first dashboard quantity is **dataset storage**, a logical byte total at an
observation time. Store bytes without conversion and display decimal GB
(`bytes / 10^9`) or TB (`bytes / 10^12`). It is a storage level, not a cumulative
creation counter. Reclamation can reduce it.

### Source and scope

Galaxy's `dataset` table records `file_size`, `total_size`, `purged`, `deleted`,
`state`, `object_store_id`, and `external_filename`. `total_size` includes the
primary file and extra dataset files. Dataset associations in histories and
libraries can refer to the same dataset; sum each dataset row once rather than
joining associations and multiplying its size.

Use this initial contract:

- Include non-purged stored datasets in configured and user-owned object stores,
  including library datasets and deleted datasets awaiting purge.
- Exclude externally linked files (`external_filename` is nonempty) and deferred
  remote datasets not materialized into an object store. Unknown storage states
  remain visible as coverage exceptions.
- Prefer `total_size`; fall back to `file_size` only with a recorded fallback
  count. That fallback can omit extra files and makes the figure an estimate.
- If both sizes are absent, count the missing observation rather than assigning
  zero. Retain a known-byte subtotal and coverage; present incomplete coverage
  explicitly, and use null when no usable measurements exist. A verified empty
  population has a zero total.
- Record observation time, definition version, included dataset count,
  unknown-size count, and fallback count with the byte total. Keep backend
  grouping available internally where supported; initially show one server total.

This includes storage managed through Galaxy even when the user supplies the
object store. It does not claim that the server operator owns that capacity.
Physical filesystem occupancy can additionally include caches, replicas, backups,
job working directories, temporary files, metadata, and orphaned files. Database
dataset sizes cannot establish that physical total or backend free capacity.

Current gxadmin `query disk-usage` sums
`COALESCE(total_size, file_size, 0)` for non-purged datasets, grouped by
`object_store_id`. It is the starting point, but needs the scope and coverage
behavior above: it currently includes linked/deferred records and treats absent
sizes as zero. Keep the SQL and compatibility handling in gxadmin.

### Quotas and storage options

The server can use a disk backend, distributed backends, hierarchical storage,
or remote object stores. Backend configuration controls user selection, privacy,
quota source, and whether usage counts against quota. User-owned object stores
are configured through templates and represented by `user_object_store` records;
their dataset IDs use the `user_objects://` object-store scheme.

`galaxy_user.disk_usage` and `user_quota_source_usage.disk_usage` are quota
accounting surfaces. They are not a complete server storage inventory: Galaxy's
accounting excludes library datasets and user-owned object stores and can
separate or exclude backend usage according to configuration. Summing user
quotas or quota usage is therefore not the chosen dataset-storage metric.

The initial dashboard does not need a quota/backend breakdown. usegalaxy.* is
free to users; quotas limit resources and are not user charges.

### Time and backfill

Capture the current storage level when collection runs. Preserve that actual
timestamp alongside the reporting month; do not relabel a delayed reading as a
measurement made at month end. Summing datasets created before a historical
date cannot reconstruct storage at that date after purges and size changes.
Earlier periods remain unavailable unless genuine historical observations exist.
Fleet figures disclose contributing sites, coverage, and observation dates.

### Source references

These definitions were checked against Galaxy's model and sample configurations
and gxadmin's query implementation:

- [Galaxy dataset model and size calculation](https://github.com/galaxyproject/galaxy/blob/a8304c80dc86127e72d79346217e1803a05af41f/lib/galaxy/model/__init__.py#L4811)
- [Galaxy quota accounting](https://github.com/galaxyproject/galaxy/blob/a8304c80dc86127e72d79346217e1803a05af41f/lib/galaxy/model/__init__.py#L711)
- [Object store configuration examples](https://github.com/galaxyproject/galaxy/blob/a8304c80dc86127e72d79346217e1803a05af41f/config/object_store_conf.sample.yml)
- [User-owned S3 storage template](https://github.com/galaxyproject/galaxy/blob/a8304c80dc86127e72d79346217e1803a05af41f/lib/galaxy/objectstore/templates/examples/production_aws_s3.yml)
- [gxadmin disk-usage query](https://github.com/galaxyproject/gxadmin/blob/f79d41b7bb4d22b392a3774d43407e346d57ca33/parts/22-query.sh#L1352)

## New engaged accounts

`engaged_new` counts distinct non-null site user IDs that registered and created
at least one job within the same UTC month. Its activity definition must match
the overall engaged count. Subtract it from that count to obtain returning
engaged accounts over matched coverage. Missing registration coverage makes the
split incomplete. Fleet sums count site accounts, not unique people.

## Tool rankings

Retain monthly job counts and allocated core-hours for all tools centrally;
publish approximately the top 100 ranked by either metric for the requested
population. Preserve full raw IDs and versions. Tool families retain toolshed
host, owner, repository, and tool identity; local tools remain site-scoped.
Keep job-count definitions and compute eligibility explicit, and report
allocation coverage. Network rankings must be calculated before truncation.

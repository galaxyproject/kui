# Architecture and data flow

## Purpose

KUI presents monthly usage statistics for usegalaxy servers, with a page for each
server and a combined network view. Its audience includes service managers,
funders, and the Galaxy community.

The system collects data from Galaxy, prepares public dashboard data, and
publishes a website. BigQuery stores the collected statistics. JSON files carry
those statistics into the website, so visitors can use the dashboard without
access to BigQuery or a Galaxy database.

## How it works today

```text
Galaxy database
  → gxadmin + kui.sh: calculate monthly statistics
  → BigQuery tables: store those statistics
  → fetch-data.mjs: create public JSON snapshots
  → KUI website: display charts and comparisons
```

### 1. Collect monthly statistics

`collector/kui.sh` runs on each participating usegalaxy server. It uses gxadmin
to query the Galaxy database and calculate statistics such as monthly job counts
and engaged users. It also obtains the installed-tool count from Galaxy's API.
It writes the results into that server's BigQuery tables.

Today, those tables already contain summarized values, grouped into users,
jobs, and service usage. A monthly job count, for example, has already been
calculated before it reaches BigQuery.

### 2. Create public JSON snapshots

A scheduled GitHub Actions workflow runs `scripts/fetch-data.mjs`. This script
reads the BigQuery tables, brings the users/jobs/usage figures together by month,
and writes one JSON snapshot per server into the KUI repository. Missing months
or data groups remain explicitly missing.

This stage packages and aligns the statistics. The monthly counts were computed
by the collection queries; the combined network figures are calculated by the
dashboard.

### 3. Build and display the website

The website is built from the committed JSON snapshots and published on GitHub
Pages. Its charts and cards calculate trends, year-over-year comparisons, and
combined figures across servers as the reader changes the date range.

Collection and snapshot refresh normally happen monthly. The website serves
its published snapshots between refreshes; new activity in Galaxy becomes
visible after a later collection, snapshot refresh, and website publication.

## What gxrdb will add

The next stage retains detailed observations, including individual jobs and
their recorded resource metrics. These can support both KUI summaries and other
consumers, such as scripts preparing a research dataset.

**gxrdb is the private BigQuery data store and its processing rules.** It does
not require another database server at each usegalaxy installation. The central
processing below is planned; the current dashboard still follows the
monthly-statistics path above.

```text
Galaxy database
  → gxadmin + kui.sh: collect detailed observations
  → private BigQuery tables: receive and retain observations
  → central workflow: validate uploads and calculate monthly summaries
  → fetch-data.mjs: write approved summaries to public JSON
  → KUI website: display the dashboard
```

The central workflow will have two responsibilities:

1. **Accept complete uploads.** Check that the expected pieces arrived and that
   their formats, counts, and relationships are consistent. Retain valid
   observations and record an acceptance receipt. The collector uses that
   receipt to save its progress and safely remove its local upload files.
   Incomplete or invalid uploads stay out of published results.
2. **Prepare consumer data.** Apply agreed metric definitions to accepted
   observations, maintain corrected job records, and calculate monthly summaries.
   The JSON export selects the summaries approved for public use.

For example, a job recording 3,600 runtime seconds and two allocated slots
contributes two allocated core-hours to its month's summary, provided it meets
the counting rules. KUI receives the monthly aggregate; the individual job
record remains private.

Keeping observations lets the project revise calculations without repeating the
original extraction from Galaxy. It also enables future investigation of
resource metrics whose units or measurement scope are uncertain. Raw metric
collection starts before that normalization work is complete.

## Why collection and processing have separate schedules

Galaxy collection remains monthly. Central acceptance and processing work on
data already uploaded to BigQuery; they do not query Galaxy again.

A monthly collection or historical backfill can produce several upload batches.
Each batch needs acceptance before the collector can safely release its local
copy and advance its progress. Central processing can run after an upload, or
more frequently during backfill and recovery, without increasing Galaxy query
frequency. An every-few-hours schedule is an operating option, not an
architectural requirement.

## Privacy and reporting confidence

Detailed job, metric, and account observations in gxrdb remain private. Public
JSON contains approved dashboard summaries. Research-dataset preparation and
release are separate downstream activities.

Missing data stays missing rather than becoming zero. Reports must show their
coverage and observation dates. Current combined headlines use each server's
latest available figure within the selected range, so contributing months can
differ; the dashboard discloses those differences.

New indicators will move to gxrdb individually after validation. Existing data
sources remain active until their replacements are ready.

## Further reading

- [Implementation reference](implementation.md): code locations, snapshot schemas,
  frontend boundaries, and calculation conventions for developers and agents.
- [Metric definitions](metrics.md): what the reported quantities mean.
- [Operations](operations.md): collection, refresh, deployment, and verification.
- [Export contract](gxrdb-export-contract.md): the detailed planned interface
  between collection and central processing.

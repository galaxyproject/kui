#!/usr/bin/env node
// Fetch per-server KUI metrics from BigQuery and write JSON snapshots that are
// committed to the repo, so the site builds with no GCP access.
//
// Usage: node scripts/fetch-data.mjs [--server <id>] [--dry-run]

import { BigQuery } from '@google-cloud/bigquery';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const snapshotDir = join(repoRoot, 'data', 'snapshots');

const COLUMNS = {
  users: [
    'total_registered',
    'new_registrations',
    'engaged',
    'engaged_day_plus',
    'new_engaged_day_plus',
  ],
  jobs: [
    'total_jobs',
    'month_jobs',
    'by_new_users',
    'by_new_users_engaged_day_plus',
    'errored',
    'errored_by_new_users',
  ],
  usage: [
    'total_histories',
    'total_datasets',
    'total_workflows',
    'total_workflow_invocations',
    'tool_installs',
  ],
};

function parseArgs(argv) {
  const args = { server: null, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--server') args.server = argv[++i];
    else if (argv[i] === '--dry-run') args.dryRun = true;
  }
  return args;
}

function monthKey(value) {
  // BigQuery DATE comes back as a BigQueryDate wrapper ({ value: 'YYYY-MM-DD' }).
  const raw = typeof value === 'string' ? value : value?.value;
  if (!raw) throw new Error(`Unparseable month value: ${JSON.stringify(value)}`);
  return raw.slice(0, 7);
}

function toNumber(value) {
  if (value === null || value === undefined) return null;
  return Number(value);
}

async function fetchTable(bq, project, dataset, table, kind) {
  const columns = COLUMNS[kind].map((c) => `\`${c}\``).join(', ');
  const query = `SELECT month, ${columns} FROM \`${project}.${dataset}.${table}\` ORDER BY month`;
  const [rows] = await bq.query({ query, location: 'US' });
  return rows;
}

function allMonthsBetween(first, last) {
  const months = [];
  let [year, month] = first.split('-').map(Number);
  const [lastYear, lastMonth] = last.split('-').map(Number);
  while (year < lastYear || (year === lastYear && month <= lastMonth)) {
    months.push(`${year}-${String(month).padStart(2, '0')}`);
    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
  }
  return months;
}

function mergeIntoMonths(tableRows) {
  const byMonth = new Map();
  for (const [kind, rows] of Object.entries(tableRows)) {
    for (const row of rows) {
      const key = monthKey(row.month);
      if (!byMonth.has(key)) byMonth.set(key, { users: null, jobs: null, usage: null });
      const metrics = {};
      for (const column of COLUMNS[kind]) metrics[column] = toNumber(row[column]);
      byMonth.get(key)[kind] = metrics;
    }
  }
  if (byMonth.size === 0) return [];

  // Emit a continuous month axis so gaps stay visible as nulls rather than
  // collapsing into a misleading straight line.
  const sorted = [...byMonth.keys()].sort();
  return allMonthsBetween(sorted[0], sorted[sorted.length - 1]).map((month) => ({
    month,
    ...(byMonth.get(month) ?? { users: null, jobs: null, usage: null }),
  }));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const registry = parse(await readFile(join(repoRoot, 'servers.yml'), 'utf8'));
  const servers = args.server
    ? registry.servers.filter((s) => s.id === args.server)
    : registry.servers;

  if (servers.length === 0) {
    console.error(`No server matching '${args.server}' in servers.yml`);
    process.exit(1);
  }

  const bq = new BigQuery({ projectId: registry.project });
  const generatedAt = new Date().toISOString();
  const failures = [];
  const indexEntries = [];

  for (const server of servers) {
    const tableRows = {};
    for (const kind of ['users', 'jobs', 'usage']) {
      const table = server.tables?.[kind];
      if (!table) {
        console.warn(`  ${server.id}: no '${kind}' table in registry, skipping`);
        continue;
      }
      try {
        tableRows[kind] = await fetchTable(bq, registry.project, registry.dataset, table, kind);
        console.log(`  ${server.id}: ${table} → ${tableRows[kind].length} rows`);
      } catch (error) {
        failures.push(`${server.id}/${table}: ${error.message}`);
      }
    }

    const months = mergeIntoMonths(tableRows);
    const snapshot = { schemaVersion: 1, server: server.id, generatedAt, months };

    indexEntries.push({
      server: server.id,
      firstMonth: months.length ? months[0].month : null,
      latestMonth: months.length ? months[months.length - 1].month : null,
      monthCount: months.length,
    });

    if (!args.dryRun) {
      await mkdir(snapshotDir, { recursive: true });
      await writeFile(join(snapshotDir, `${server.id}.json`), `${JSON.stringify(snapshot, null, 2)}\n`);
    }
  }

  if (failures.length) {
    console.error('\nFailed to read tables:');
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exit(1);
  }

  // A server that is behind on the latest month is worth flagging but is not
  // an error: admins run the collector on their own cron.
  const latest = indexEntries.map((e) => e.latestMonth).filter(Boolean).sort().pop();
  for (const entry of indexEntries) {
    if (entry.latestMonth !== latest) {
      console.warn(`WARNING: ${entry.server} latest month is ${entry.latestMonth}, behind ${latest}`);
    }
  }

  if (!args.dryRun && !args.server) {
    const index = { schemaVersion: 1, generatedAt, servers: indexEntries };
    await writeFile(join(snapshotDir, 'index.json'), `${JSON.stringify(index, null, 2)}\n`);
  }

  console.log(
    `\n${args.dryRun ? 'Would write' : 'Wrote'} ${indexEntries.length} snapshot(s) through ${latest}.`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

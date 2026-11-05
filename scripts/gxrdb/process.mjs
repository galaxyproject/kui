import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { config, clients, readJson, tableName, QueryBudget, integer, isMain, failure } from './lib.mjs';

export function sameSchema(actual, expected) {
  return isDeepStrictEqual(actual.map(f => ({ name: f.name, type: f.type, mode: f.mode ?? 'NULLABLE' })), expected);
}
export async function verifyTables(bq, c) {
  const definitions = await readJson('schemas/gxrdb/bigquery-v1.json');
  for (const [layer, datasetId] of [['intake', c.intakeDataset], ['central', c.centralDataset]]) {
    const dataset = bq.dataset(datasetId);
    const [metadata] = await dataset.getMetadata();
    if (metadata.location !== c.location) throw new Error('location_mismatch');
    if ((metadata.access ?? []).some(a => a.specialGroup || a.domain || ['allUsers', 'allAuthenticatedUsers'].includes(a.iamMember))) throw new Error('dataset_not_private');
    const [tables] = await dataset.getTables();
    const expectedNames = Object.keys(definitions.tables).filter(k => k.startsWith(`${layer}.`)).map(k => k.split('.')[1]).sort();
    if (!isDeepStrictEqual(tables.map(t => t.id).sort(), expectedNames)) throw new Error('unexpected_table');
    for (const id of expectedNames) {
      const [m] = await dataset.table(id).getMetadata();
      const expected = definitions.tables[`${layer}.${id}`];
      if (!sameSchema(m.schema.fields, expected.schema.fields)) throw new Error('schema_mismatch');
      if (m.timePartitioning?.type !== expected.timePartitioning?.type || m.timePartitioning?.field !== expected.timePartitioning?.field ||
          !isDeepStrictEqual(m.clustering?.fields, expected.clustering?.fields) || m.expirationTime || m.timePartitioning?.expirationMs) throw new Error('schema_mismatch');
    }
  }
}
export async function processEmpty(bq, c, { checkTables = verifyTables, runId = randomUUID() } = {}) {
  const started = new Date().toISOString();
  await checkTables(bq, c);
  const budget = new QueryBudget(bq, c);
  const rows = await budget.query(`SELECT COUNT(*) AS count FROM ${tableName(c, c.intakeDataset, 'manifests')}`);
  const count = integer(rows[0].count);
  const status = count === 0n ? 'empty' : 'blocked_unimplemented';
  await budget.query(`INSERT INTO ${tableName(c, c.centralDataset, 'processing_runs')}
    (run_id, started_at, finished_at, status, manifest_count, workflow_run_id)
    VALUES (@run_id, TIMESTAMP(@started), CURRENT_TIMESTAMP(), @status, @count, @workflow_run_id)`,
  { run_id: runId, started, status, count: count.toString(), workflow_run_id: process.env.GITHUB_RUN_ID ?? null },
  { run_id: 'STRING', started: 'STRING', status: 'STRING', count: 'INT64', workflow_run_id: 'STRING' });
  console.log(JSON.stringify({ run_id: runId, status, manifests: count.toString(), bytes_billed: budget.billed.toString() }));
  // Slice A implements acceptance. Do not acknowledge, transform or discard a bundle here.
  if (count !== 0n) throw new Error('pending_bundles_require_slice_a');
  return { status, count, billed: budget.billed };
}
if (isMain(import.meta.url)) {
  try {
    const c = await config();
    const { bq } = await clients(c, process.env.GXRDB_IMPERSONATE);
    await processEmpty(bq, c);
  } catch (error) { failure(error); }
}

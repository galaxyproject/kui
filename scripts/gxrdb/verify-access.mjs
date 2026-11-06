import { definitions as makeDefinitions } from './schema.mjs';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config, clients, serviceAccount, readJson, tableName, QueryBudget, isMain, failure } from './lib.mjs';
import { verifyTables } from './process.mjs';

async function permission(table, names) {
  const [response] = await table.testIamPermissions(names);
  return new Set(response.permissions ?? []);
}
export async function verifyAccess() {
  const c = await config();
  const { bq: org } = await clients(c, serviceAccount(c, c.orgServiceAccountId));
  const { bq: central } = await clients(c, serviceAccount(c, c.centralServiceAccountId));
  await verifyTables(central, c);
  const own = await permission(org.dataset(c.intakeDataset).table('jobs'), ['bigquery.tables.getData', 'bigquery.tables.updateData']);
  if (!own.has('bigquery.tables.updateData')) throw new Error('org_intake_write_missing');
  for (const id of ['retained_jobs', 'acceptance_records', 'coverage', 'publications', 'processing_runs', 'fact_jobs', 'monthly_compute', 'retained_manifests', 'applied_bundles', 'quarantine']) {
    const actual = await permission(org.dataset(c.centralDataset).table(id), ['bigquery.tables.getData', 'bigquery.tables.updateData']);
    if (actual.size) throw new Error('org_central_access_leak');
  }
  const receipt = await permission(org.dataset(c.centralDataset).table('org_receipts'), ['bigquery.tables.getData', 'bigquery.tables.updateData']);
  if (!receipt.has('bigquery.tables.getData') || receipt.has('bigquery.tables.updateData')) throw new Error('receipt_permissions_wrong');
  const centralIntake = await permission(central.dataset(c.intakeDataset).table('jobs'), ['bigquery.tables.getData', 'bigquery.tables.updateData']);
  if (!centralIntake.has('bigquery.tables.getData') || centralIntake.has('bigquery.tables.updateData')) throw new Error('central_intake_permissions_wrong');
  const temp = await mkdtemp(join(tmpdir(), 'gxrdb-access-'));
  try {
    const definition = (makeDefinitions(await readJson('schemas/gxrdb/export-v1.json'))).tables['intake.jobs'];
    const path = join(temp, 'empty-jobs.csv');
    await writeFile(path, definition.schema.fields.map(f => f.name).join(',') + '\n');
    const [ownMetadata] = await org.dataset(c.intakeDataset).table('jobs').load(path, { sourceFormat: 'CSV', skipLeadingRows: 1,
      schema: definition.schema, createDisposition: 'CREATE_NEVER', writeDisposition: 'WRITE_APPEND' });
    const [metadata] = await central.job(ownMetadata.jobReference.jobId, { location: c.location }).getMetadata();
    if (metadata.status?.state !== 'DONE' || metadata.status?.errorResult) throw new Error('load_inspection_failed');
  } finally { await rm(temp, { recursive: true, force: true }); }
  const budget = new QueryBudget(org, c);
  await budget.query(`SELECT COUNT(*) AS count FROM ${tableName(c, c.centralDataset, 'org_receipts')}`);
  // Dry runs verify actual query authorization without reading rows or modifying tables.
  for (const query of [
    `SELECT COUNT(*) FROM ${tableName(c, c.centralDataset, 'retained_jobs')}`,
    `DELETE FROM ${tableName(c, c.centralDataset, 'retained_jobs')} WHERE FALSE`,
  ]) {
    try {
      await org.createQueryJob({ query, dryRun: true, useLegacySql: false, maximumBytesBilled: c.maximumBytesBilled, location: c.location });
    } catch (e) { if (e.code === 403) continue; throw e; }
    throw new Error('org_central_access_leak');
  }
  console.log(JSON.stringify({ status: 'access_verified', org_intake_load: 'allowed', org_receipts: 'read_only', org_central_data: 'denied', central_intake: 'read_only' }));
}
if (isMain(import.meta.url)) verifyAccess().catch(failure);

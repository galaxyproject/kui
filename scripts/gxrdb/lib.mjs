import { readFile } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GoogleAuth, Impersonated } from 'google-auth-library';
import { BigQuery } from '@google-cloud/bigquery';

export const root = fileURLToPath(new URL('../../', import.meta.url));
export async function readJson(path) {
  return JSON.parse(await readFile(resolve(root, path), 'utf8'));
}
export async function config() {
  return validateConfig(await readJson(process.env.GXRDB_CONFIG || 'gxrdb/dev.json'));
}
export function validateConfig(c) {
  if (typeof c.sourceEpoch !== 'string' || !c.sourceEpoch || c.sourceEpoch.length > 200) throw new Error('invalid_source_epoch');
  if (!Number.isInteger(c.maximumBundlesPerRun) || c.maximumBundlesPerRun < 1 || c.maximumBundlesPerRun > 100) throw new Error('invalid_bundle_budget');
  if (c.environment !== 'development' || c.serverId !== 'usegalaxy-org') throw new Error('unsupported_pilot');
  for (const key of ['intakeDataset', 'centralDataset']) {
    if (!/^gxrdb_dev[A-Za-z0-9_]*$/.test(c[key])) throw new Error('invalid_development_dataset');
  }
  if (c.intakeDataset === c.centralDataset) throw new Error('datasets_must_be_separate');
  if (!/^[a-z][a-z0-9-]{4,61}[a-z0-9]$/.test(c.projectId)) throw new Error('invalid_project');
  if (!/^[A-Z][A-Z0-9-]*$/.test(c.location)) throw new Error('invalid_location');
  if (!/^[1-9][0-9]*$/.test(c.maximumBytesBilled) || BigInt(c.maximumBytesBilled) > 1_000_000_000_000n) throw new Error('invalid_byte_budget');
  for (const key of ['orgServiceAccountId', 'centralServiceAccountId', 'workloadPoolId', 'workloadProviderId']) {
    if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(c[key])) throw new Error('invalid_identity');
  }
  if (c.orgServiceAccountId === c.centralServiceAccountId) throw new Error('identities_must_be_separate');
  if (!/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(c.githubRepository) || !/^[a-zA-Z0-9_-]+\.yml$/.test(c.workflowFile)) throw new Error('invalid_repository');
  for (const key of ['githubOwnerId', 'githubRepositoryId']) if (!/^[1-9][0-9]*$/.test(c[key])) throw new Error('invalid_github_id');
  return c;
}
export const serviceAccount = (c, id) => `${id}@${c.projectId}.iam.gserviceaccount.com`;
export function providerCondition(c) {
  return `assertion.repository_owner_id == '${c.githubOwnerId}' && assertion.repository_id == '${c.githubRepositoryId}' && assertion.ref == 'refs/heads/main' && assertion.workflow_ref == '${c.githubRepository}/.github/workflows/${c.workflowFile}@refs/heads/main'`;
}
export async function clients(c, impersonate) {
  const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
  const source = await auth.getClient();
  const authClient = impersonate ? new Impersonated({
    sourceClient: source, targetPrincipal: impersonate, lifetime: 900,
    targetScopes: ['https://www.googleapis.com/auth/cloud-platform'],
  }) : source;
  return { auth: authClient, bq: new BigQuery({ projectId: c.projectId, location: c.location, authClient }) };
}
export function tableName(c, dataset, table) {
  if (![c.intakeDataset, c.centralDataset].includes(dataset) || !/^[a-z][a-z0-9_]*$/.test(table)) throw new Error('invalid_table');
  return `\`${c.projectId}.${dataset}.${table}\``;
}
export class QueryBudget {
  constructor(bq, c) { this.bq = bq; this.c = c; this.remaining = BigInt(c.maximumBytesBilled); this.billed = 0n; }
  async query(query, params = {}, types = {}) {
    if (this.remaining <= 0n) throw new Error('query_budget_exhausted');
    const [job] = await this.bq.createQueryJob({ query, params, types,
      useLegacySql: false, location: this.c.location, maximumBytesBilled: this.remaining.toString(),
      jobTimeoutMs: 120000, labels: { application: 'gxrdb', environment: 'development' },
    });
    let rows, originalError;
    try { [rows] = await job.getQueryResults({ wrapIntegers: true, timeoutMs: 120000 }); }
    catch (error) { originalError = error; }
    let metadata;
    try { [metadata] = await job.getMetadata(); }
    catch (error) { this.remaining = 0n; throw originalError ?? error; }
    const billed = BigInt(metadata.statistics?.query?.totalBytesBilled ?? '0');
    this.remaining -= billed; this.billed += billed;
    // Failed or timed-out work can still be billable. Unknown completion
    // exhausts the run budget rather than allowing unaccounted follow-up work.
    if (originalError && metadata.status?.state !== 'DONE') this.remaining = 0n;
    if (this.remaining < 0n) throw new Error('query_budget_exceeded');
    if (originalError) throw originalError;
    return rows;
  }
}
export const integer = value => BigInt(typeof value === 'object' && value !== null ? value.value : value);
export function isMain(meta) {
  return meta === new URL(`file://${resolve(process.argv[1] || '')}`).href;
}
// BigQuery errors can contain SQL or source values. Public logs receive codes only.
export function failure(error) {
  const allowed = new Set(['pending_bundles_require_slice_a', 'query_budget_exhausted', 'query_budget_exceeded', 'schema_mismatch', 'location_mismatch', 'unexpected_table', 'dataset_not_private']);
  console.error(JSON.stringify({ status: 'failed', reason: allowed.has(error.message) ? error.message : 'operation_failed' }));
  process.exitCode = 1;
}

export function sameSchema(actual, expected) {
  return isDeepStrictEqual(actual.map(f => ({ name: f.name, type: f.type, mode: f.mode ?? 'NULLABLE' })), expected);
}

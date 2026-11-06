import { definitions as makeDefinitions } from './schema.mjs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { config, clients, readJson, serviceAccount, providerCondition, isMain, failure } from './lib.mjs';

const exec = promisify(execFile);
async function cloud(args) {
  const { stdout } = await exec('gcloud', [...args, '--quiet', '--format=json'], { maxBuffer: 4 * 1024 * 1024 });
  return stdout.trim() ? JSON.parse(stdout) : null;
}
async function describe(args) {
  try { return await cloud(args); }
  catch (e) { if (/NOT_FOUND|does not exist|not found/i.test(e.stderr ?? '')) return null; throw e; }
}
export function datasetAccess(c, operator, layer) {
  const central = serviceAccount(c, c.centralServiceAccountId);
  return [{ role: 'OWNER', userByEmail: operator },
    { role: layer === 'intake' ? 'READER' : 'WRITER', userByEmail: central },
    ...(layer === 'intake' ? [{ role: 'WRITER', userByEmail: serviceAccount(c, c.orgServiceAccountId) }] : [])];
}
export async function provision(apply = false, grantLoadInspector = false) {
  const c = await config();
  const defs = makeDefinitions(await readJson('schemas/gxrdb/export-v1.json'));
  if (!apply) {
    console.log(JSON.stringify({ project: c.projectId, datasets: [c.intakeDataset, c.centralDataset], tables: Object.keys(defs.tables).length,
      serviceAccounts: [c.orgServiceAccountId, c.centralServiceAccountId], providerCondition: providerCondition(c),
      schedule: 'manual', mode: 'plan_only' }, null, 2));
    return;
  }
  const { stdout } = await exec('gcloud', ['config', 'get-value', 'account']);
  const operator = stdout.trim();
  if (!/^[^\s@]+@[^\s@]+$/.test(operator) || operator.endsWith('.gserviceaccount.com')) throw new Error('human_operator_required');
  const projectArgs = [`--project=${c.projectId}`];
  const project = await cloud(['projects', 'describe', c.projectId]);
  await cloud(['services', 'enable', 'bigquery.googleapis.com', 'iam.googleapis.com', 'iamcredentials.googleapis.com', 'sts.googleapis.com', ...projectArgs]);
  for (const id of [c.orgServiceAccountId, c.centralServiceAccountId]) {
    const email = serviceAccount(c, id);
    const existing = await describe(['iam', 'service-accounts', 'describe', email, ...projectArgs]);
    if (!existing) await cloud(['iam', 'service-accounts', 'create', id, '--display-name=KUI gxrdb development', ...projectArgs]);
    await cloud(['projects', 'add-iam-policy-binding', c.projectId, `--member=serviceAccount:${email}`, '--role=roles/bigquery.jobUser', '--condition=None']);
    // Short-lived impersonation for the operator's development checks; no keys.
    await cloud(['iam', 'service-accounts', 'add-iam-policy-binding', email, `--member=user:${operator}`, '--role=roles/iam.serviceAccountTokenCreator', '--condition=None', ...projectArgs]);
  }
  // This project-level metadata permission needs separate operator approval.
  if (grantLoadInspector) {
    const roleId = 'gxrdbJobMetadataReader';
    const role = await describe(['iam', 'roles', 'describe', roleId, ...projectArgs]);
    if (!role) await cloud(['iam', 'roles', 'create', roleId, '--title=gxrdb load job metadata reader', '--permissions=bigquery.jobs.get', '--stage=GA', ...projectArgs]);
    else if (JSON.stringify(role.includedPermissions) !== JSON.stringify(['bigquery.jobs.get'])) throw new Error('job_metadata_role_drift');
    await cloud(['projects', 'add-iam-policy-binding', c.projectId, `--member=serviceAccount:${serviceAccount(c, c.centralServiceAccountId)}`, `--role=projects/${c.projectId}/roles/${roleId}`, '--condition=None']);
  }
  const { bq } = await clients(c);
  for (const [layer, id] of [['intake', c.intakeDataset], ['central', c.centralDataset]]) {
    const dataset = bq.dataset(id);
    const [exists] = await dataset.exists();
    if (exists) {
      const [m] = await dataset.getMetadata();
      if (m.labels?.application !== 'gxrdb' || m.labels?.environment !== 'development') throw new Error('unmanaged_dataset');
      if (m.location !== c.location) throw new Error('location_mismatch');
    } else {
      await bq.createDataset(id, { location: c.location, labels: { application: 'gxrdb', environment: 'development' },
        description: 'Private gxrdb development data; org-only pilot. No automatic expiry.', access: datasetAccess(c, operator, layer) });
    }
    await dataset.setMetadata({ access: datasetAccess(c, operator, layer) });
  }
  for (const [key, definition] of Object.entries(defs.tables)) {
    const [layer, id] = key.split('.');
    const ds = bq.dataset(layer === 'intake' ? c.intakeDataset : c.centralDataset);
    const [exists] = await ds.table(id).exists();
    if (!exists) await ds.createTable(id, { ...definition, labels: { application: 'gxrdb', environment: 'development' } });
    else {
      const [m] = await ds.table(id).getMetadata();
      const old = m.schema.fields.map(f => ({ name: f.name, type: f.type, mode: f.mode ?? 'NULLABLE' }));
      const wanted = definition.schema.fields;
      if (JSON.stringify(old) !== JSON.stringify(wanted)) {
        if (JSON.stringify(old) !== JSON.stringify(wanted.slice(0, old.length)) || wanted.slice(old.length).some(f => f.mode !== 'NULLABLE')) throw new Error('schema_mismatch');
        await ds.table(id).setMetadata({ schema: definition.schema });
      }
    }
  }
  // A per-org receipt table is the only central table the collector may read.
  const receipt = bq.dataset(c.centralDataset).table('org_receipts');
  const [policy] = await receipt.getIamPolicy();
  const member = `serviceAccount:${serviceAccount(c, c.orgServiceAccountId)}`;
  const bindings = policy.bindings ?? [];
  let binding = bindings.find(b => b.role === 'roles/bigquery.dataViewer');
  if (!binding) { binding = { role: 'roles/bigquery.dataViewer', members: [] }; bindings.push(binding); }
  if (!binding.members.includes(member)) binding.members.push(member);
  await receipt.setIamPolicy({ version: 1, etag: policy.etag, bindings });

  const poolArgs = ['--location=global', ...projectArgs];
  const pool = await describe(['iam', 'workload-identity-pools', 'describe', c.workloadPoolId, ...poolArgs]);
  if (!pool) await cloud(['iam', 'workload-identity-pools', 'create', c.workloadPoolId, '--display-name=KUI gxrdb development', ...poolArgs]);
  const providerArgs = [`--workload-identity-pool=${c.workloadPoolId}`, ...poolArgs];
  const provider = await describe(['iam', 'workload-identity-pools', 'providers', 'describe', c.workloadProviderId, ...providerArgs]);
  const settings = ['--issuer-uri=https://token.actions.githubusercontent.com',
    '--attribute-mapping=google.subject=assertion.sub,attribute.repository_id=assertion.repository_id',
    `--attribute-condition=${providerCondition(c)}`];
  if (!provider) await cloud(['iam', 'workload-identity-pools', 'providers', 'create-oidc', c.workloadProviderId, ...providerArgs, ...settings]);
  else {
    if (provider.attributeCondition !== providerCondition(c) || provider.oidc?.issuerUri !== 'https://token.actions.githubusercontent.com') throw new Error('identity_provider_drift');
  }
  const principal = `principalSet://iam.googleapis.com/projects/${project.projectNumber}/locations/global/workloadIdentityPools/${c.workloadPoolId}/attribute.repository_id/${c.githubRepositoryId}`;
  await cloud(['iam', 'service-accounts', 'add-iam-policy-binding', serviceAccount(c, c.centralServiceAccountId), `--member=${principal}`, '--role=roles/iam.workloadIdentityUser', '--condition=None', ...projectArgs]);
  console.log(JSON.stringify({ status: 'provisioned', datasets: 2, tables: Object.keys(defs.tables).length,
    workloadIdentityProvider: `projects/${project.projectNumber}/locations/global/workloadIdentityPools/${c.workloadPoolId}/providers/${c.workloadProviderId}`,
    centralServiceAccount: serviceAccount(c, c.centralServiceAccountId) }));
}
if (isMain(import.meta.url)) provision(process.argv.includes('--apply'), process.argv.includes('--grant-load-inspector')).catch(failure);

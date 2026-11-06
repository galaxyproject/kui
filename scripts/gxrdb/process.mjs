import { definitions as makeDefinitions } from './schema.mjs';
import { randomUUID } from 'node:crypto';
import { intakeBundles, acceptBundle, quarantine } from './receiver.mjs';
import { BundleError } from './bundle.mjs';
import { rebuildFacts } from './facts.mjs';
import { isDeepStrictEqual } from 'node:util';
import { config, clients, readJson, tableName, QueryBudget, isMain, failure, sameSchema } from './lib.mjs';

export { sameSchema };
export async function verifyTables(bq, c) {
  const definitions = makeDefinitions(await readJson('schemas/gxrdb/export-v1.json'));
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
          !isDeepStrictEqual(m.clustering?.fields, expected.clustering?.fields) || Boolean(m.requirePartitionFilter) !== Boolean(expected.requirePartitionFilter) || m.expirationTime || m.timePartitioning?.expirationMs) throw new Error('schema_mismatch');
    }
  }
}
export async function processBundles(bq,c,options={}) {
  await (options.checkTables??verifyTables)(bq,c);
  const budget = new QueryBudget(bq,c);
  const submissions = await intakeBundles(c,budget);
  const runId = randomUUID(); const started = new Date().toISOString();
  let accepted = 0, rejected = 0, acceptedJobs = 0;
  for (const row of submissions) {
    try {
      const result = await acceptBundle(row.manifest_json,row.transport_json,c,budget,options.jobClient??bq,{envelope:row,...options});
      if (!result.replay) { accepted++; acceptedJobs += result.manifest.components.find(x=>x.name==='jobs').rows; }
    } catch (error) {
      if (!(error instanceof BundleError)) throw error;
      await quarantine(row.manifest_json,row.transport_json,c,budget,error.message);
      rejected++;
    }
  }
  const publication = await rebuildFacts(c,budget,options);
  await budget.query(`INSERT INTO ${tableName(c,c.centralDataset,'processing_runs')}
    (run_id,started_at,finished_at,status,manifest_count,workflow_run_id)
    VALUES(@run,TIMESTAMP(@started),CURRENT_TIMESTAMP(),@status,@count,@workflow)`,
    {run:runId,started,status:rejected?'quarantined':'processed',count:String(submissions.length),workflow:process.env.GITHUB_RUN_ID??null},
    {run:'STRING',started:'STRING',status:'STRING',count:'INT64',workflow:'STRING'});
  const summary={run_id:runId,status:rejected?'quarantined':'processed',accepted,rejected,accepted_jobs:acceptedJobs,query_count:budget.queries,bytes_billed_per_accepted_job:acceptedJobs ? (budget.billed/BigInt(acceptedJobs)).toString() : null,bytes_billed:budget.billed.toString(),revision:publication.revision};
  console.log(JSON.stringify(summary));
  if (rejected) throw new Error('bundles_quarantined');
  return summary;
}
if (isMain(import.meta.url)) {
  try {
    const c = await config();
    const { bq } = await clients(c, process.env.GXRDB_IMPERSONATE);
    await processBundles(bq, c);
  } catch (error) { failure(error); }
}

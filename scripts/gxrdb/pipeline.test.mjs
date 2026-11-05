import test from 'node:test';
import assert from 'node:assert/strict';
import { readJson, validateConfig, QueryBudget } from './lib.mjs';
import { definitions } from './schema.mjs';
import { processBundles, sameSchema } from './process.mjs';

const c = await readJson('gxrdb/dev.json');
const skipMetadata = async () => {};
function fakeBQ(count, billed = '0') {
  const calls = [];
  return { calls, createQueryJob: async options => {
    calls.push(options);
    return [{ getQueryResults: async () => [[{ count: { value: count } }]],
      getMetadata: async () => [{ statistics: { query: { totalBytesBilled: billed } } }] }];
  } };
}
test('pilot config refuses unrelated datasets, colliding identities and unsafe identifiers', () => {
  assert.doesNotThrow(() => validateConfig(c));
  for (const patch of [
    { intakeDataset: 'kui' }, { centralDataset: c.intakeDataset }, { projectId: 'project` WHERE TRUE' },
    { centralServiceAccountId: c.orgServiceAccountId }, { maximumBytesBilled: '0' },
    { maximumBytesBilled: '1000000000001' }, { serverId: 'another-server' },
    { githubRepositoryId: "123' || true" },
  ]) assert.throws(() => validateConfig({ ...c, ...patch }));
});
test('checked-in warehouse schema preserves every contract field, its order and exact types', async () => {
  const contract = await readJson('schemas/gxrdb/export-v1.json');
  assert.deepEqual(await readJson('schemas/gxrdb/bigquery-v1.json'), definitions(contract));
  const warehouse = definitions(contract);
  assert.deepEqual(await readJson('collector/schemas/gxrdb-v1.json'), Object.fromEntries(['jobs','numeric_metrics','manifests'].map(n=>[n,warehouse.tables[`intake.${n}`].schema.fields])));
  const fields = warehouse.tables['intake.numeric_metrics'].schema.fields;
  assert.equal(fields.find(f => f.name === 'metric_value_raw').type, 'STRING');
  assert.equal(fields.find(f => f.name === 'job_id').type, 'INTEGER');
  assert.equal(sameSchema(fields, [...fields].reverse()), false);
});
test('byte budget declines across jobs, caps each job and refuses further work at exhaustion', async () => {
  const bq = fakeBQ('0', '10'); const budget = new QueryBudget(bq, { ...c, maximumBytesBilled: '20' });
  await budget.query('SELECT 1'); await budget.query('SELECT 1');
  assert.deepEqual(bq.calls.map(x => x.maximumBytesBilled), ['20', '10']);
  await assert.rejects(budget.query('SELECT 1'), /budget_exhausted/);
  assert.equal(bq.calls.length, 2);
});
test('empty Slice A run performs no bundle acceptance and records its run', async () => {
  const calls=[];
  const bq={createQueryJob:async options=>{
    calls.push(options);
    return [{getQueryResults:async()=>[[]],getMetadata:async()=>[{statistics:{query:{totalBytesBilled:'0'}}}]}];
  }};
  const result=await processBundles(bq,c,{checkTables:skipMetadata});
  assert.equal(result.accepted,0);
  assert.equal(result.rejected,0);
  assert.equal(calls.length,3);
  assert.match(calls[2].query,/INSERT INTO .*processing_runs/);
  assert.equal(calls[2].params.status,'processed');
});
test('metadata failure stops before any query or write', async () => {
  const bq=fakeBQ('0');
  await assert.rejects(processBundles(bq,c,{checkTables:async()=>{throw new Error('schema_mismatch');}}),/schema_mismatch/);
  assert.equal(bq.calls.length,0);
});
test('failed queries deduct billed bytes and unknown completion exhausts the budget', async () => {
  for (const state of ['DONE','RUNNING']) {
    const original=new Error('failed_query');
    const bq={createQueryJob:async()=>[{getQueryResults:async()=>{throw original;},getMetadata:async()=>[{status:{state},statistics:{query:{totalBytesBilled:'7'}}}]}]};
    const budget=new QueryBudget(bq,{...c,maximumBytesBilled:'20'});
    await assert.rejects(budget.query('SELECT 1'),e=>e===original);
    assert.equal(budget.billed,7n);
    assert.equal(budget.remaining,state==='DONE'?13n:0n);
  }
});

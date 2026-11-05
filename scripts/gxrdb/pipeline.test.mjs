import test from 'node:test';
import assert from 'node:assert/strict';
import { readJson, validateConfig, QueryBudget } from './lib.mjs';
import { definitions } from './schema.mjs';
import { processEmpty, sameSchema } from './process.mjs';

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
  const fields = definitions(contract).tables['intake.numeric_metrics'].schema.fields;
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
test('empty pipeline writes only a processing-run record, never an acceptance receipt', async () => {
  const bq = fakeBQ('0');
  const out = await processEmpty(bq, c, { checkTables: skipMetadata, runId: 'test-empty' });
  assert.equal(out.status, 'empty');
  assert.equal(bq.calls.length, 2);
  assert.match(bq.calls[1].query, /INSERT INTO .*processing_runs/);
  assert.equal(bq.calls[1].params.status, 'empty');
});
test('pending upload fails closed and is never acknowledged, including counts above JS exact range', async () => {
  const bq = fakeBQ('9007199254740993');
  await assert.rejects(processEmpty(bq, c, { checkTables: skipMetadata, runId: 'test-pending' }), /pending_bundles_require_slice_a/);
  assert.equal(bq.calls.length, 2);
  assert.equal(bq.calls[1].params.count, '9007199254740993');
  assert.equal(bq.calls[1].types.count, 'INT64');
  assert.equal(bq.calls[1].params.status, 'blocked_unimplemented');
});
test('metadata failure stops before any query or write', async () => {
  const bq = fakeBQ('0');
  await assert.rejects(processEmpty(bq, c, { checkTables: async () => { throw new Error('schema_mismatch'); } }), /schema_mismatch/);
  assert.equal(bq.calls.length, 0);
});

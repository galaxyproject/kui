import { writeFile } from 'node:fs/promises';
import { readJson, root, isMain } from './lib.mjs';

const types = { uuid: 'STRING', string: 'STRING', int64: 'INTEGER', utc_timestamp: 'TIMESTAMP', boolean: 'BOOLEAN', decimal_text: 'STRING', json_array_text: 'STRING' };
const field = (name, type, required = false) => ({ name, type, mode: required ? 'REQUIRED' : 'NULLABLE' });
export function definitions(contract) {
  const out = { contractVersion: contract.contractVersion, tables: {} };
  for (const [name, component] of Object.entries(contract.components)) {
    const fields = [...contract.envelope, ...component.fields].map(f => {
      if (!types[f.type]) throw new Error('unknown_contract_type');
      return field(f.name, types[f.type], !f.nullable);
    });
    for (const [layer, id] of [['intake', name], ['central', `retained_${name}`]]) {
      out.tables[`${layer}.${id}`] = { schema: { fields }, timePartitioning: { type: 'DAY' }, clustering: { fields: ['server_id', 'source_epoch', 'bundle_id'] } };
    }
  }
  out.tables['intake.manifests'] = { schema: { fields: [
    field('bundle_id', 'STRING', true), field('server_id', 'STRING', true), field('source_epoch', 'STRING', true),
    field('observation_generation', 'INTEGER', true), field('manifest_json', 'STRING', true),
    field('submitted_at', 'TIMESTAMP', true),
  ] }, timePartitioning: { type: 'DAY', field: 'submitted_at' }, clustering: { fields: ['server_id', 'bundle_id'] } };
  out.tables['central.acceptance_records'] = { schema: { fields: [
    field('bundle_id', 'STRING', true), field('server_id', 'STRING', true), field('source_epoch', 'STRING', true),
    field('observation_generation', 'INTEGER', true), field('manifest_sha256', 'STRING', true),
    field('status', 'STRING', true), field('reason_code', 'STRING'), field('recorded_at', 'TIMESTAMP', true),
  ] }, timePartitioning: { type: 'DAY', field: 'recorded_at' }, clustering: { fields: ['server_id', 'bundle_id'] } };
  // Collector sees only its receipts, never retained observations or processing tables.
  out.tables['central.org_receipts'] = { schema: out.tables['central.acceptance_records'].schema };
  out.tables['central.coverage'] = { schema: { fields: [
    field('server_id', 'STRING', true), field('source_epoch', 'STRING', true), field('family', 'STRING', true),
    field('creation_month', 'DATE', true), field('status', 'STRING', true), field('observed_at', 'TIMESTAMP', true),
    field('details_json', 'STRING', true),
  ] }, timePartitioning: { type: 'MONTH', field: 'creation_month' }, clustering: { fields: ['server_id', 'family'] } };
  out.tables['central.publications'] = { schema: { fields: [
    field('revision_id', 'STRING', true), field('server_id', 'STRING', true), field('creation_month', 'DATE', true),
    field('family', 'STRING', true), field('status', 'STRING', true), field('recorded_at', 'TIMESTAMP', true),
    field('lineage_json', 'STRING', true),
  ] }, timePartitioning: { type: 'MONTH', field: 'creation_month' }, clustering: { fields: ['server_id', 'family'] } };
  out.tables['central.processing_runs'] = { schema: { fields: [
    field('run_id', 'STRING', true), field('started_at', 'TIMESTAMP', true), field('finished_at', 'TIMESTAMP', true),
    field('status', 'STRING', true), field('manifest_count', 'INTEGER', true), field('workflow_run_id', 'STRING'),
  ] }, timePartitioning: { type: 'DAY', field: 'started_at' } };
  return out;
}
if (isMain(import.meta.url)) {
  const schema = definitions(await readJson('schemas/gxrdb/export-v1.json'));
  await writeFile(`${root}/schemas/gxrdb/bigquery-v1.json`, `${JSON.stringify(schema, null, 2)}\n`);
}

import { createHash } from 'node:crypto';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { definitions as makeDefinitions } from './schema.mjs';
import { readJson, serviceAccount, sameSchema } from './lib.mjs';

const contract = await readJson('schemas/gxrdb/export-v1.json');
const definitions = makeDefinitions(contract);
const ajv = new Ajv2020({ strict: false, allErrors: false }); addFormats(ajv);
for (const [name,positive] of [['int64',false],['int64-positive',true]]) ajv.addFormat(name,{type:'string',validate:value=>{try { exactInt(value,positive); return true; } catch { return false; }}});
const valid = ajv.compile(await readJson('schemas/gxrdb/manifest-v1.schema.json'));
const MAX = 9223372036854775807n;
export const sha256 = raw => createHash('sha256').update(raw).digest('hex');
export class BundleError extends Error { constructor(code) { super(code); this.name = 'BundleError'; } }
export function check(condition, code) { if (!condition) throw new BundleError(code); }
export function exactInt(value, positive = false) {
  check(typeof value === 'string' && /^(0|[1-9][0-9]{0,18})$/.test(value), 'invalid_int64');
  const n = BigInt(value); check(n <= MAX && (!positive || n > 0n), 'invalid_int64'); return n;
}
export function validateBundle(raw, transportRaw, c, envelope) {
  check(Buffer.byteLength(raw) <= 1048576 && typeof transportRaw === 'string' && Buffer.byteLength(transportRaw) <= 1048576, 'manifest_too_large');
  let m, t; try { m = JSON.parse(raw); t = JSON.parse(transportRaw); } catch { throw new BundleError('invalid_json'); }
  check(valid(m), 'manifest_schema');
  check(m.serverId === c.serverId && m.sourceEpoch === c.sourceEpoch, 'unknown_source');
  const release = /^(\d+)\.(\d+)(?:[.\-+].*)?$/.exec(m.source.galaxyRelease);
  check(release && (BigInt(release[1]) > 26n || (release[1] === '26' && BigInt(release[2]) >= 1n)), 'unsupported_galaxy_release');
  check(m.selection.entity === 'jobs', 'unsupported_selection');
  if (m.selection.mode === 'id_range') {
    const lo = BigInt(m.selection.lowExclusive), hi = BigInt(m.selection.highInclusive);
    check(hi >= lo && hi - lo <= 50000n, 'unbounded_selection');
  } else {
    check(m.selection.mode === 'id_list', 'unsupported_selection');
    check(m.selection.ids.length <= 50000, 'unbounded_selection');
  }
  const names = ['jobs', 'numeric_metrics'];
  check(JSON.stringify([...m.requestedComponents].sort()) === JSON.stringify(names), 'component_set');
  check(m.components.length === 2 && new Set(m.components.map(x => x.name)).size === 2, 'component_set');
  check(t && Object.keys(t).sort().join() === 'capabilitiesJson,parts' && Array.isArray(t.parts) && typeof t.capabilitiesJson === 'string', 'transport_schema');
  check(sha256(t.capabilitiesJson) === m.source.capabilitiesSha256, 'capability_hash');
  let cap; try { cap = JSON.parse(t.capabilitiesJson); } catch { throw new BundleError('capability_json'); }
  check(cap.contractVersion === m.contractVersion && cap.galaxyRelease === m.source.galaxyRelease && cap.postgresqlVersion === m.source.postgresqlVersion && cap.exporterBuild === m.source.exporterBuild && cap.timestampInterpretation === 'UTC', 'capability_mismatch');
  let parts = 0, bytes = 0;
  for (const component of m.components) {
    check(names.includes(component.name) && component.status === 'complete' && component.parts.length <= 100, 'unsupported_component');
    const columns = [...contract.envelope, ...contract.components[component.name].fields].map(f => f.name);
    check(cap.components?.[component.name]?.schemaVersion === component.schemaVersion && cap.components?.[component.name]?.status === 'supported' && JSON.stringify(cap.components[component.name].columns) === JSON.stringify(columns), 'capability_columns');
    check(component.rows <= (component.name === 'jobs' ? 50000 : 5000000), 'row_budget');
    let rows = 0;
    for (const [index, part] of component.parts.entries()) {
      check(part.partIndex === index && part.file === `${component.name}-${String(index).padStart(5, '0')}.jsonl.gz`, 'part_identity');
      rows += part.rows; bytes += part.compressedBytes; parts++;
      const receipts = t.parts.filter(x => x.component === component.name && x.partIndex === index);
      check(receipts.length === 1, 'load_receipt_membership');
      const receipt = receipts[0];
      check(Object.keys(receipt).sort().join() === 'attempt,component,jobId,partIndex,sha256' && Number.isSafeInteger(receipt.attempt) && receipt.attempt >= 0 && receipt.attempt <= 100, 'load_receipt_schema');
      check(receipt.sha256 === part.sha256 && receipt.jobId === `gxrdb_${m.bundleId.replaceAll('-', '')}_${component.name}_${index}_a${receipt.attempt}_h${part.sha256}`, 'load_identity');
    }
    check(rows === component.rows, 'part_count_sum');
  }
  check(parts === t.parts.length && bytes <= 1073741824, 'bundle_budget');
  if (envelope) check(typeof (envelope.observation_generation?.value ?? envelope.observation_generation) === 'string' && envelope.bundle_id === m.bundleId && envelope.server_id === m.serverId && envelope.source_epoch === m.sourceEpoch && String(envelope.observation_generation?.value ?? envelope.observation_generation) === m.observationGeneration, 'submission_envelope');
  return { manifest: m, transport: t, hash: sha256(raw), raw };
}
export async function verifyLoadJobs(bundle, c, jobClient) {
  const { manifest: m, transport: t } = bundle;
  for (const component of m.components) for (const part of component.parts) {
    const receipt = t.parts.find(x => x.component === component.name && x.partIndex === part.partIndex);
    const [job] = await jobClient.job(receipt.jobId, { location: c.location }).getMetadata();
    const load = job.configuration?.load;
    check(job.status?.state === 'DONE' && !job.status.errorResult, 'load_not_successful');
    check(job.user_email === serviceAccount(c, c.orgServiceAccountId), 'load_identity_owner');
    check(job.jobReference.projectId === c.projectId && job.jobReference.jobId === receipt.jobId && job.jobReference.location.toUpperCase() === c.location.toUpperCase(), 'load_identity');
    check(load?.destinationTable?.projectId === c.projectId && load.destinationTable.datasetId === c.intakeDataset && load.destinationTable.tableId === component.name, 'load_destination');
    check(load.sourceFormat === 'NEWLINE_DELIMITED_JSON' && (load.writeDisposition ?? 'WRITE_APPEND') === 'WRITE_APPEND' && !load.autodetect && !load.ignoreUnknownValues && !load.allowJaggedRows && Number(load.maxBadRecords ?? 0) === 0, 'load_options');
    check(sameSchema(load.schema?.fields ?? [], definitions.tables[`intake.${component.name}`].schema.fields), 'load_schema');
    check(BigInt(job.statistics?.load?.inputFiles ?? '-1') === 1n && !load.sourceUris?.length, 'load_input_file');
    check(BigInt(job.statistics?.load?.outputRows ?? '-1') === BigInt(part.rows) && BigInt(job.statistics?.load?.badRecords ?? '0') === 0n, 'load_row_count');
  }
}
export { contract, definitions };

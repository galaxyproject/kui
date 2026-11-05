import { contract, definitions, BundleError, check, sha256, validateBundle, verifyLoadJobs } from './bundle.mjs';
import { tableName, integer } from './lib.mjs';

export function selectionSQL(selection, column = 'job_id') {
  return selection.mode === 'id_range' ? `(${column} > @low AND ${column} <= @high)` : `${column} IN UNNEST(@ids)`;
}
export function selectionParameters(m) {
  return m.selection.mode === 'id_range' ? { params: { low: m.selection.lowExclusive, high: m.selection.highInclusive }, types: { low: 'INT64', high: 'INT64' } } : { params: { ids: m.selection.ids }, types: { ids: ['INT64'] } };
}
export function acceptanceSQL(bundle, c, { injectFailure = false } = {}) {
  const { manifest: m } = bundle;
  const central = id => tableName(c, c.centralDataset, id);
  const intake = id => tableName(c, c.intakeDataset, id);
  let sql = `BEGIN TRANSACTION;
    DELETE FROM ${central('acceptance_records')} WHERE FALSE;
    ASSERT NOT EXISTS (SELECT 1 FROM ${central('acceptance_records')} WHERE bundle_id=@id
      AND (status != 'accepted' OR manifest_sha256 != @hash OR server_id != @server OR source_epoch != @epoch OR observation_generation != @generation)) AS 'gxrdb_validate_bundle_identity';
    ASSERT NOT EXISTS (SELECT 1 FROM ${central('acceptance_records')} WHERE server_id=@server AND source_epoch=@epoch
      AND observation_generation=@generation AND bundle_id!=@id) AS 'gxrdb_validate_generation_identity';
    IF NOT EXISTS (SELECT 1 FROM ${central('acceptance_records')} WHERE bundle_id=@id AND status='accepted') THEN
  `;
  for (const comp of m.components) {
    const key = comp.name === 'jobs' ? 'job_id' : 'metric_id';
    sql += `CREATE TEMP TABLE stage_${comp.name} AS SELECT DISTINCT * FROM ${intake(comp.name)} WHERE bundle_id=@id;
      ASSERT (SELECT COUNT(*) FROM stage_${comp.name})=${comp.rows} AS 'gxrdb_validate_component_rows';
      ASSERT NOT EXISTS (SELECT 1 FROM stage_${comp.name} WHERE server_id!=@server OR source_epoch!=@epoch OR observation_generation!=@generation
        OR part_index NOT IN (${comp.parts.map(p => p.partIndex).join(',')}) OR ${key}<0) AS 'gxrdb_validate_envelope';
      ASSERT NOT EXISTS (SELECT ${key} FROM stage_${comp.name} GROUP BY ${key} HAVING COUNT(*)>1) AS 'gxrdb_validate_source_keys';
    `;
    for (const part of comp.parts) sql += `ASSERT (SELECT COUNT(*) FROM stage_${comp.name} WHERE part_index=${part.partIndex})=${part.rows} AS 'gxrdb_validate_part_rows';\n`;
  }
  sql += `ASSERT NOT EXISTS (SELECT 1 FROM stage_jobs WHERE NOT ${selectionSQL(m.selection)}) AS 'gxrdb_validate_selection';
    ASSERT NOT EXISTS (SELECT 1 FROM stage_numeric_metrics m LEFT JOIN stage_jobs j USING(job_id) WHERE j.job_id IS NULL) AS 'gxrdb_validate_job_membership';
    ASSERT NOT EXISTS (SELECT 1 FROM stage_numeric_metrics WHERE NOT (${contract.numericMetricAllowList.map(p => `(plugin='${p.plugin}' AND metric_name='${p.metricName}')`).join(' OR ')})) AS 'gxrdb_validate_metric_allowlist';
  `;
  for (const comp of m.components) {
    const columns = definitions.tables[`central.retained_${comp.name}`].schema.fields.map(f => f.name).join(',');
    sql += `INSERT INTO ${central(`retained_${comp.name}`)} (${columns}) SELECT ${columns} FROM stage_${comp.name};\n`;
  }
  if (injectFailure) sql += `ASSERT FALSE AS 'injected_acceptance_failure';\n`;
  sql += `INSERT INTO ${central('retained_manifests')}
    (bundle_id,server_id,source_epoch,observation_generation,manifest_json,submitted_at,transport_json)
    VALUES (@id,@server,@epoch,@generation,@manifest,TIMESTAMP(@observed),@transport);
    INSERT INTO ${central('acceptance_records')} (bundle_id,server_id,source_epoch,observation_generation,manifest_sha256,status,reason_code,recorded_at)
      VALUES (@id,@server,@epoch,@generation,@hash,'accepted',NULL,CURRENT_TIMESTAMP());
    INSERT INTO ${central('org_receipts')} (bundle_id,server_id,source_epoch,observation_generation,manifest_sha256,status,reason_code,recorded_at)
      VALUES (@id,@server,@epoch,@generation,@hash,'accepted',NULL,CURRENT_TIMESTAMP());
    END IF;
    COMMIT TRANSACTION;`;
  return sql;
}
export async function acceptBundle(raw, transport, c, budget, jobClient, options = {}) {
  const bundle = validateBundle(raw, transport, c, options.envelope);
  const m = bundle.manifest;
  const params = { id: m.bundleId, server: m.serverId, epoch: m.sourceEpoch, generation: m.observationGeneration,
    hash: bundle.hash, manifest: raw, transport, observed: m.observedAt };
  const types = Object.fromEntries(Object.keys(params).map(k => [k, k === 'generation' ? 'INT64' : 'STRING']));
  // A matching retained acceptance survives BigQuery's load-job history expiry.
  const prior = await budget.query(`SELECT manifest_sha256,status,server_id,source_epoch,CAST(observation_generation AS STRING) AS generation FROM ${tableName(c,c.centralDataset,'acceptance_records')} WHERE bundle_id=@id`, {id:m.bundleId}, {id:'STRING'});
  if (prior.length) {
    check(prior.length === 1 && prior[0].manifest_sha256 === bundle.hash && prior[0].server_id === m.serverId && prior[0].source_epoch === m.sourceEpoch && prior[0].generation === m.observationGeneration && prior[0].status === 'accepted', 'bundle_identity');
    return { manifest: m, replay: true };
  }
  await verifyLoadJobs(bundle, c, jobClient);
  const selection = selectionParameters(m);
  try { await budget.query(acceptanceSQL(bundle,c,options), {...params,...selection.params}, {...types,...selection.types}); }
  catch (error) {
    const marker = /gxrdb_validate_([a-z_]+)/.exec(error.message ?? '');
    if (marker) throw new BundleError(marker[1]);
    throw error;
  }
  return { manifest: m, replay: false };
}
export async function quarantine(raw, transport, c, budget, reason) {
  const hash = sha256(raw);
  let m;try { m=JSON.parse(raw); } catch { m={}; }
  const safeEnvelope = typeof m.bundleId === 'string' && /^[0-9a-f-]{36}$/.test(m.bundleId) &&
    m.serverId === c.serverId && m.sourceEpoch === c.sourceEpoch && typeof m.observationGeneration === 'string' && /^[1-9][0-9]{0,18}$/.test(m.observationGeneration) && BigInt(m.observationGeneration)<=9223372036854775807n;
  const central = id => tableName(c,c.centralDataset,id);
  let sql = `BEGIN TRANSACTION; DELETE FROM ${central('acceptance_records')} WHERE FALSE;
    DELETE FROM ${central('quarantine')} WHERE FALSE;
    IF NOT EXISTS (SELECT 1 FROM ${central('quarantine')} WHERE submission_sha256=@hash) THEN
      INSERT INTO ${central('quarantine')} VALUES (@hash,@id,@reason,@manifest,CURRENT_TIMESTAMP());
    END IF;`;
  if (safeEnvelope) sql += `
    IF NOT EXISTS (SELECT 1 FROM ${central('acceptance_records')} WHERE bundle_id=@id) THEN
      INSERT INTO ${central('acceptance_records')} VALUES (@id,@server,@epoch,@generation,@hash,'rejected',@reason,CURRENT_TIMESTAMP());
      INSERT INTO ${central('org_receipts')} VALUES (@id,@server,@epoch,@generation,@hash,'rejected',@reason,CURRENT_TIMESTAMP());
    END IF;`;
  sql += ' COMMIT TRANSACTION;';
  const params = {hash,id: typeof m.bundleId === 'string' ? m.bundleId : null,reason,manifest:raw};
  const types = {hash:'STRING',id:'STRING',reason:'STRING',manifest:'STRING'};
  if (safeEnvelope) Object.assign(params,{server:c.serverId,epoch:c.sourceEpoch,generation:m.observationGeneration}),Object.assign(types,{server:'STRING',epoch:'STRING',generation:'INT64'});
  await budget.query(sql,params,types);
}
export async function intakeBundles(c,budget) {
  return budget.query(`SELECT * EXCEPT(row_number) FROM (
    SELECT m.*, ROW_NUMBER() OVER(PARTITION BY bundle_id,TO_HEX(SHA256(manifest_json)) ORDER BY submitted_at DESC) AS row_number
    FROM ${tableName(c,c.intakeDataset,'manifests')} m
    WHERE NOT EXISTS (SELECT 1 FROM ${tableName(c,c.centralDataset,'acceptance_records')} a WHERE a.bundle_id=m.bundle_id AND a.manifest_sha256=LOWER(TO_HEX(SHA256(m.manifest_json))))
      AND NOT EXISTS (SELECT 1 FROM ${tableName(c,c.centralDataset,'quarantine')} q WHERE q.submission_sha256=LOWER(TO_HEX(SHA256(m.manifest_json))))
    ) WHERE row_number=1 ORDER BY submitted_at LIMIT ${c.maximumBundlesPerRun}`);
}

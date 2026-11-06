import { randomUUID } from 'node:crypto';
import { tableName } from './lib.mjs';
import { contract, definitions } from './bundle.mjs';

export function covers(manifest, jobId) {
  return `((${jobId}>${manifest}.selection_low AND ${jobId}<=${manifest}.selection_high)
    OR ${jobId} IN UNNEST(${manifest}.selection_ids))`;
}
const terminal = "('ok','error','deleted')";
export function rebuildSQL(c) {
  const t = id => tableName(c,c.centralDataset,id);
  const jobFields = contract.components.jobs.fields.map(f => f.name);
  const factFields = definitions.tables['central.fact_jobs'].schema.fields.map(f=>f.name).join(',');
  const coreNames = {runtime:'runtime_seconds',slots:'galaxy_slots',memory:'galaxy_memory_mb'};
  const corePivot = Object.entries(coreNames).flatMap(([name,metric]) => [
    `MIN(IF(metric_name='${metric}',value,NULL)) AS ${name}`,
    `MIN(IF(metric_name='${metric}',status,NULL)) AS ${name}_status`,
  ]).join(',');
  const cpu = "metric_name IN ('cpuacct.usage','cpu.stat.usage_usec','cpu.stat.user_usec','cpu.stat.system_usec')";
  const memory = "metric_name IN ('memory.peak','memory.max_usage_in_bytes','memory.memsw.max_usage_in_bytes')";
  const oom = "metric_name IN ('memory.events.oom_kill','memory.oom_control.oom_kill')";
  const version2 = "metric_name IN ('memory.peak','memory.max','memory.events.oom','memory.events.oom_kill','cpu.stat.usage_usec','cpu.stat.user_usec','cpu.stat.system_usec')";
  const version1 = "metric_name IN ('cpuacct.usage','memory.max_usage_in_bytes','memory.memsw.max_usage_in_bytes','memory.limit_in_bytes','memory.memsw.limit_in_bytes','memory.failcnt','memory.oom_control.oom_kill','memory.oom_control.oom_kill_disable','memory.oom_control.under_oom')";
  const trust = (name,predicate) => `COUNTIF(${predicate}) AS ${name}_rows,COUNTIF(${predicate} AND metric_value_raw IS NOT NULL) AS ${name}_values`;
  const trustValue = name => `CASE WHEN COALESCE(g.${name}_rows,0)=0 THEN 'missing' WHEN g.${name}_values=0 THEN 'no_usable_value' ELSE 'unresolved' END`;
  return `
  DECLARE affected_months ARRAY<DATE>;
  DECLARE rebuild_null BOOL;
  BEGIN TRANSACTION;
  DELETE FROM ${t('applied_bundles')} WHERE FALSE;
  CREATE TEMP TABLE todo AS SELECT m.* FROM ${t('retained_manifests')} m
    WHERE server_id=@server AND source_epoch=@epoch AND NOT EXISTS(SELECT 1 FROM ${t('applied_bundles')} a WHERE a.bundle_id=m.bundle_id)
    ORDER BY observation_generation LIMIT ${c.maximumBundlesPerRun};
  IF (SELECT COUNT(*) FROM todo)>0 THEN
    CREATE TEMP TABLE changed_ids AS SELECT DISTINCT j.job_id FROM ${t('retained_jobs')} j
      WHERE j.server_id=@server AND j.source_epoch=@epoch AND EXISTS(SELECT 1 FROM todo x WHERE x.server_id=j.server_id AND x.source_epoch=j.source_epoch AND ${covers('x','j.job_id')});
    SET affected_months=(SELECT IFNULL(ARRAY_AGG(DISTINCT DATE_TRUNC(DATE(j.create_time),MONTH) IGNORE NULLS),ARRAY<DATE>[])
      FROM ${t('retained_jobs')} j JOIN changed_ids USING(job_id) WHERE j.server_id=@server AND j.source_epoch=@epoch);
    SET rebuild_null=EXISTS(SELECT 1 FROM ${t('retained_jobs')} j JOIN changed_ids USING(job_id) WHERE j.server_id=@server AND j.source_epoch=@epoch AND j.create_time IS NULL);
    ASSERT ARRAY_LENGTH(affected_months)<=1200 AS 'affected_month_budget';
    CREATE TEMP TABLE known_ids AS SELECT DISTINCT j.server_id,j.source_epoch,j.job_id FROM ${t('retained_jobs')} j
      WHERE j.server_id=@server AND j.source_epoch=@epoch AND (DATE_TRUNC(DATE(j.create_time),MONTH) IN UNNEST(affected_months) OR (rebuild_null AND j.create_time IS NULL));
    CREATE TEMP TABLE replacement AS
    WITH last_content AS (
      SELECT j.* FROM ${t('retained_jobs')} j JOIN known_ids USING(job_id)
      WHERE j.server_id=@server AND j.source_epoch=@epoch
      QUALIFY ROW_NUMBER() OVER(PARTITION BY j.job_id ORDER BY j.observation_generation DESC)=1
    ), covering AS (
      SELECT k.job_id,m.* FROM known_ids k JOIN ${t('retained_manifests')} m ON m.server_id=k.server_id AND m.source_epoch=k.source_epoch AND ${covers('m','k.job_id')}
      WHERE m.server_id=@server AND m.source_epoch=@epoch
      QUALIFY ROW_NUMBER() OVER(PARTITION BY k.job_id ORDER BY m.observation_generation DESC)=1
    ), metrics AS (
      SELECT n.* FROM ${t('retained_numeric_metrics')} n JOIN covering o ON n.bundle_id=o.bundle_id AND n.job_id=o.job_id
      WHERE n.server_id=@server AND n.source_epoch=@epoch
    ), canonical_metrics AS (
      SELECT * FROM metrics
      QUALIFY ROW_NUMBER() OVER(PARTITION BY job_id,plugin,metric_name ORDER BY metric_id DESC)=1
    ), core_values AS (
      SELECT job_id,metric_name,SAFE_CAST(metric_value_raw AS BIGNUMERIC) AS value,
        IF(SAFE_CAST(metric_value_raw AS BIGNUMERIC) IS NULL,'missing','present') AS status
      FROM canonical_metrics WHERE plugin='core' AND metric_name IN ('runtime_seconds','galaxy_slots','galaxy_memory_mb')
    ), core AS (SELECT job_id,${corePivot} FROM core_values GROUP BY job_id),
    cgroup AS (SELECT job_id,${trust('cpu',cpu)},${trust('memory',memory)},${trust('oom',oom)},
      COUNTIF(${version1})>0 AS v1,COUNTIF(${version2})>0 AS v2 FROM canonical_metrics WHERE plugin='cgroup' GROUP BY job_id),
    inputs AS (
      SELECT o.bundle_id,j.server_id,j.source_epoch,o.observation_generation,j.part_index,${jobFields.map(f=>`j.${f}`).join(',')},
        j.bundle_id AS content_bundle_id,o.submitted_at AS observed_at,
        DATE_TRUNC(DATE(j.create_time),MONTH) AS created_month,j.bundle_id=o.bundle_id AS is_present,
        COALESCE(j.state_raw IN ${terminal},FALSE) AS is_terminal,
        CASE WHEN j.copied_from_job_id IS NOT NULL THEN 'copied' WHEN j.imported IS TRUE THEN 'imported' WHEN j.imported IS FALSE THEN 'eligible' ELSE 'unknown_copy_marker' END AS compute_eligibility,
        k.runtime AS runtime_seconds,k.slots AS slots_allocated,k.memory AS memory_allocated_mb_raw,
        COALESCE(k.runtime_status,'missing') AS runtime_status,COALESCE(k.slots_status,'missing') AS slots_status,COALESCE(k.memory_status,'missing') AS memory_allocation_status,
        ${trustValue('cpu')} AS cpu_trust_status,${trustValue('memory')} AS memory_trust_status,${trustValue('oom')} AS oom_trust_status,
        CASE WHEN g.v1 AND g.v2 THEN 'mixed' WHEN g.v1 THEN 'v1' WHEN g.v2 THEN 'v2' ELSE 'unknown' END AS cgroup_version,
        COALESCE(g.cpu_rows,0)>0 AS cpu_metric_present,COALESCE(g.memory_rows,0)>0 AS memory_metric_present,COALESCE(g.oom_rows,0)>0 AS oom_metric_present
      FROM covering o JOIN last_content j USING(job_id) LEFT JOIN core k USING(job_id) LEFT JOIN cgroup g USING(job_id)
    ), statuses AS (
      SELECT *,CASE WHEN NOT is_present THEN 'source_deleted' WHEN compute_eligibility!='eligible' THEN compute_eligibility
        WHEN NOT is_terminal THEN 'pending' WHEN runtime_status!='present' THEN 'runtime_'||runtime_status
        WHEN slots_status!='present' THEN 'slots_'||slots_status WHEN runtime_seconds<0 THEN 'invalid_runtime'
        WHEN slots_allocated<=0 OR slots_allocated!=TRUNC(slots_allocated) THEN 'invalid_slots'
        WHEN SAFE_MULTIPLY(runtime_seconds,slots_allocated) IS NULL THEN 'overflow' ELSE 'usable' END AS allocation_status FROM inputs
    )
    SELECT *,CASE WHEN allocation_status='usable' THEN SAFE_DIVIDE(SAFE_MULTIPLY(runtime_seconds,slots_allocated),CAST(3600 AS BIGNUMERIC)) END AS allocated_core_hours,
      @revision AS revision_id FROM statuses;
    FOR slice IN (SELECT month FROM UNNEST(affected_months) month) DO
      DELETE FROM ${t('fact_jobs')} WHERE server_id=@server AND source_epoch=@epoch AND created_month=slice.month;
      INSERT INTO ${t('fact_jobs')} (${factFields}) SELECT ${factFields} FROM replacement WHERE created_month=slice.month;
      DELETE FROM ${t('monthly_compute')} WHERE server_id=@server AND source_epoch=@epoch AND created_month=slice.month;
      INSERT INTO ${t('monthly_compute')}
        SELECT @server,@epoch,slice.month,COUNT(*),COUNTIF(compute_eligibility='eligible' AND is_terminal),COUNTIF(allocation_status='usable'),COUNTIF(NOT is_terminal),
          SUM(allocated_core_hours),'provisional',FALSE,@revision
        FROM ${t('fact_jobs')} WHERE created_month=slice.month AND server_id=@server AND source_epoch=@epoch AND is_present
        HAVING COUNT(*)>0;
      INSERT INTO ${t('publications')} VALUES(@revision,@server,slice.month,'allocated_core_hours','provisional',CURRENT_TIMESTAMP(),
        TO_JSON_STRING(STRUCT('allocated-core-hours-v1' AS definition,ARRAY(SELECT bundle_id FROM todo ORDER BY observation_generation) AS bundles)));
    END FOR;
    IF rebuild_null THEN
      DELETE FROM ${t('fact_jobs')} WHERE server_id=@server AND source_epoch=@epoch AND created_month IS NULL;
      INSERT INTO ${t('fact_jobs')} (${factFields}) SELECT ${factFields} FROM replacement WHERE created_month IS NULL;
    END IF;
    INSERT INTO ${t('applied_bundles')} SELECT bundle_id,server_id,source_epoch,@revision,CURRENT_TIMESTAMP() FROM todo;
  END IF;
  COMMIT TRANSACTION;
  SELECT COUNT(*) AS applied FROM ${t('applied_bundles')} WHERE revision_id=@revision;`;
}
export async function rebuildFacts(c,budget,options={}) {
  const revision=options.revision??randomUUID();
  const rows=await budget.query(rebuildSQL(c,options),{server:c.serverId,epoch:c.sourceEpoch,revision},{server:'STRING',epoch:'STRING',revision:'STRING'});
  return {revision,applied:rows[0]?.applied};
}

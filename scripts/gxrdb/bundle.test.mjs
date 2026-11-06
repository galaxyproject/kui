import test from 'node:test';
import assert from 'node:assert/strict';
import { config, serviceAccount } from './lib.mjs';
import { sha256, contract, definitions, validateBundle, verifyLoadJobs, exactInt } from './bundle.mjs';
import { acceptanceSQL } from './receiver.mjs';
const c=await config();
function example() {
  const cap={contractVersion:'1.0.0',galaxyRelease:'26.2',postgresqlVersion:'17.2',exporterBuild:'unit-build',timestampInterpretation:'UTC',numericMetricAllowList:contract.numericMetricAllowList.map(p=>[p.plugin,p.metricName]),textMetrics:[],components:Object.fromEntries(['jobs','numeric_metrics'].map(n=>[n,{schemaVersion:1,status:'supported',columns:[...contract.envelope,...contract.components[n].fields].map(f=>f.name)}]))};
  const capabilitiesJson=JSON.stringify(cap);
  const m={contractVersion:'1.0.0',bundleId:'123e4567-e89b-42d3-a456-426614174000',serverId:c.serverId,sourceEpoch:c.sourceEpoch,observationGeneration:'9007199254740993',observedAt:'2026-11-05T00:00:00.000000Z',
    selection:{entity:'jobs',mode:'id_list',ids:['9007199254740993','9223372036854775807']},source:{galaxyRelease:'26.2',postgresqlVersion:'17.2',exporterBuild:'unit-build',gxadminVersion:'24',snapshotId:'1:2:',timestampInterpretation:'UTC',capabilitiesSha256:sha256(capabilitiesJson)},requestedComponents:['jobs','numeric_metrics'],
    components:['jobs','numeric_metrics'].map(name=>({name,schemaVersion:1,status:'complete',rows:0,parts:[{partIndex:0,file:`${name}-00000.jsonl.gz`,rows:0,compressedBytes:100,sha256:'ab'.repeat(32)}]}))};
  const t={capabilitiesJson,parts:m.components.map(x=>({component:x.name,partIndex:0,jobId:`gxrdb_${m.bundleId.replaceAll('-','')}_${x.name}_0_a0_h${'ab'.repeat(32)}`,attempt:0,sha256:'ab'.repeat(32)}))};
  return{m,t};
}
function validate({m,t}){return validateBundle(JSON.stringify(m),JSON.stringify(t),c);}
function metadata(b) {
  return b.manifest.components.map(comp=>({user_email:serviceAccount(c,c.orgServiceAccountId),jobReference:{projectId:c.projectId,location:c.location,jobId:b.transport.parts.find(p=>p.component===comp.name).jobId},status:{state:'DONE'},statistics:{load:{inputFiles:'1',outputRows:'0',badRecords:'0'}},configuration:{load:{destinationTable:{projectId:c.projectId,datasetId:c.intakeDataset,tableId:comp.name},sourceFormat:'NEWLINE_DELIMITED_JSON',schema:definitions.tables[`intake.${comp.name}`].schema}}}));
}
const jobs = values=>({job:id=>({getMetadata:async()=>[values.find(j=>j.jobReference.jobId===id)]})});
test('valid empty snapshots and exact INT64 bounds are supported',()=>{
  const b=validate(example());assert.equal(b.manifest.observationGeneration,'9007199254740993');
  assert.equal(exactInt('9223372036854775807'),9223372036854775807n);
  assert.throws(()=>exactInt('9223372036854775808'));
});
test('manifest/transport validation rejects malformed and incomplete identity sets',()=>{
  const changes=[
    e=>e.m.components.pop(),e=>e.m.components.push(structuredClone(e.m.components[0])),e=>e.m.components[0].rows=1,
    e=>e.m.components[0].parts[0].file='../jobs.jsonl.gz',e=>e.m.observationGeneration='9223372036854775808',
    e=>e.m.selection.ids=['9223372036854775808'],e=>e.m.serverId='another-site',e=>e.m.sourceEpoch='another-epoch',
    e=>e.m.source.galaxyRelease='26.0',
    e=>e.t.parts.pop(),e=>e.t.parts[0].jobId='unrelated_job',e=>e.t.capabilitiesJson+=' ',
    e=>e.m.selection={entity:'jobs',mode:'id_range',lowExclusive:'0',highInclusive:'50001'},
  ];
  for(const change of changes){const e=example();change(e);assert.throws(()=>validate(e));}
});
test('successful job metadata must prove the exact destination, owner, schema, checksum and counts',async()=>{
  const b=validate(example());await verifyLoadJobs(b,c,jobs(metadata(b)));
  const changes=[m=>m.status.errorResult={reason:'backendError'},m=>m.user_email='other@example.invalid',
    m=>m.configuration.load.destinationTable.datasetId='kui',m=>m.configuration.load.autodetect=true,
    m=>m.configuration.load.writeDisposition='WRITE_TRUNCATE',m=>m.configuration.load.maxBadRecords=1,m=>m.configuration.load.schema.fields=[...m.configuration.load.schema.fields].reverse(),
    m=>m.statistics.load.outputRows='1',m=>m.statistics.load.inputFiles='2'];
  for(const change of changes){const m=structuredClone(metadata(b));change(m[0]);await assert.rejects(verifyLoadJobs(b,c,jobs(m)));}
});
test('transient load metadata failures stay retriable, not source-data rejection',async()=>{
  const b=validate(example());const error=Object.assign(new Error('temporary'),{code:503});
  await assert.rejects(verifyLoadJobs(b,c,{job:()=>({getMetadata:async()=>{throw error;}})}),e=>e===error);
});
test('acceptance transaction has explicit typed column targets and a publication boundary',()=>{
  const sql=acceptanceSQL(validate(example()),c);
  assert.match(sql,/INSERT INTO .*retained_jobs` \(bundle_id,server_id/);
  assert.match(sql,/COMMIT TRANSACTION/);assert.doesNotMatch(sql,/fact_jobs/);
});

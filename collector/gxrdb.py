#!/usr/bin/env python3
"""Durable bounded job-observation collection. No source SQL or local database."""
import argparse
import csv
import fcntl
import gzip
import hashlib
import io
import json
import os
from pathlib import Path
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import uuid

MAX_INT64 = 9223372036854775807
TERMINAL = {'ok', 'error', 'deleted'}


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode('utf-8')


def atomic(path, value):
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    temp = path.with_name(path.name + '.new')
    with temp.open('wb') as out:
        os.chmod(temp, 0o600)
        out.write(canonical(value))
        out.flush()
        os.fsync(out.fileno())
    os.replace(temp, path)
    fd = os.open(path.parent, os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def number(value):
    if not isinstance(value, str) or not re.fullmatch(r'0|[1-9][0-9]{0,18}', value) or int(value) > MAX_INT64:
        raise ValueError('invalid_int64')
    return int(value)


def configuration(path):
    c = json.loads(Path(path).read_text())
    for key in ['projectId', 'intakeDataset', 'centralDataset']:
        if not re.fullmatch(r'[A-Za-z0-9_-]+', c[key]):
            raise ValueError('invalid_destination')
    if not re.fullmatch(r'[a-z0-9][a-z0-9-]*', c['serverId']) or not c['sourceEpoch']:
        raise ValueError('invalid_source_identity')
    if c.get('timestampInterpretation') != 'UTC':
        raise ValueError('verified_utc_required')
    if not Path(c['stateDirectory']).is_absolute() or Path(c['stateDirectory']) in [Path('/'), Path.home()]:
        raise ValueError('invalid_state_directory')
    for key, default, minimum, maximum in [
        ('maxSpoolBytes', 8589934592, 16777216, 21474836480), ('maxOutputBytes', 268435456, 1024, 1073741824),
        ('maxRows', 50000, 1, 50000), ('maxRangeWidth', 50000, 1, 50000), ('maxPendingBundles', 32, 1, 200), ('maxPendingJobs', 50000, 1, 1000000),
        ('maxRuntimeSeconds', 3600, 1, 3600), ('acceptedGraceSeconds', 3600, 0, 604800),
    ]:
        c.setdefault(key, default)
        if type(c[key]) is not int or not minimum <= c[key] <= maximum:
            raise ValueError('invalid_budget')
    c.setdefault('location', 'US')
    c.setdefault('maximumBytesBilled', '4294967296')
    number(c['maximumBytesBilled'])
    c.setdefault('gxadmin', 'gxadmin')
    if sys.version_info < (3, 13):
        raise ValueError('Python 3.13 or later is required')
    c.setdefault('bqCommand', ['bq'])
    return c


def table_schemas():
    contract = json.loads((Path(__file__).parent.parent/'schemas/gxrdb/export-v1.json').read_text())
    types = {'uuid':'STRING', 'string':'STRING', 'int64':'INTEGER', 'utc_timestamp':'TIMESTAMP',
             'boolean':'BOOLEAN', 'decimal_text':'STRING', 'json_array_text':'STRING'}
    schemas = {name: [{'name':f['name'], 'type':types[f['type']], 'mode':'NULLABLE' if f['nullable'] else 'REQUIRED'}
        for f in contract['envelope']+contract['components'][name]['fields']] for name in ['jobs','numeric_metrics']}
    schemas['manifests'] = [{'name':n, 'type':t, 'mode':m} for n,t,m in [
        ('bundle_id','STRING','REQUIRED'),('server_id','STRING','REQUIRED'),('source_epoch','STRING','REQUIRED'),
        ('observation_generation','INTEGER','REQUIRED'),('manifest_json','STRING','REQUIRED'),
        ('submitted_at','TIMESTAMP','REQUIRED'),('transport_json','STRING','NULLABLE')]]
    return schemas


class BigQuery:
    def __init__(self, c):
        self.c = c
        self.deadline = time.monotonic() + c['maxRuntimeSeconds']
        self.remaining = int(c['maximumBytesBilled'])

    def check_time(self):
        if time.monotonic() >= self.deadline:
            raise ValueError('run_budget_exceeded')

    def command(self, args, job_id=None):
        self.check_time()
        cmd = self.c.get('bqCommand', ['bq']) + ['--quiet', '--format=json',
            '--project_id='+self.c['projectId'], '--location='+self.c['location']]
        if job_id:
            cmd += ['--job_id='+job_id]
        return subprocess.run(cmd + args, capture_output=True, text=True,
            timeout=max(1, self.deadline-time.monotonic()))

    def job(self, job_id):
        result = self.command(['show', '-j', job_id])
        if result.returncode:
            if 'Not found: Job' in result.stdout + result.stderr:
                return None
            raise RuntimeError(result.stderr or result.stdout)
        return json.loads(result.stdout)

    def wait(self, job_id):
        while True:
            job = self.job(job_id)
            if job is None or job['status']['state'] == 'DONE':
                return job
            self.check_time()
            time.sleep(1)

    def query(self, sql, params=None):
        if self.remaining <= 0:
            raise ValueError('query_budget_exceeded')
        job_id = 'gxrdb_read_' + uuid.uuid4().hex
        result = self.command(['query', '--use_legacy_sql=false', '--max_rows=1000',
            '--maximum_bytes_billed='+str(self.remaining)] +
            ['--parameter='+k+':STRING:'+v for k,v in (params or {}).items()] + [sql], job_id)
        job = self.wait(job_id)
        if job is None or job['status'].get('errorResult'):
            self.remaining = 0
            raise RuntimeError(result.stderr or result.stdout or 'receipt_query_failed')
        self.remaining -= int(job.get('statistics', {}).get('query', {}).get('totalBytesBilled', '0'))
        if self.remaining < 0:
            raise ValueError('query_budget_exceeded')
        if result.returncode:
            raise RuntimeError(result.stderr or result.stdout)
        return json.loads(result.stdout)

    def load(self, path, table, schema, job_id, source_format='NEWLINE_DELIMITED_JSON'):
        schema_path = path.parent/(table+'.schema.json')
        atomic(schema_path, schema)
        args = ['load', '--source_format='+source_format, '--noreplace', '--noautodetect', '--max_bad_records=0']
        result = self.command(args + [self.c['projectId']+':'+self.c['intakeDataset']+'.'+table,
            str(path), str(schema_path)], job_id)
        job = self.wait(job_id)
        if job is None:
            raise RuntimeError(result.stderr or result.stdout or 'load_response_unknown')
        return job


def package_source(source, output, request, schemas):
    metadata = json.loads((source/'metadata.json').read_text())
    cap = metadata['capabilities']
    if (metadata.get('formatVersion') != 1 or cap.get('formatVersion') != 1
            or metadata.get('selection') != request['selection']
            or cap.get('timestampInterpretation') != 'UTC'):
        raise ValueError('source_export_mismatch')
    wire_cap = {k: v for k, v in cap.items() if k not in ['formatVersion', 'gxadminVersion']}
    wire_cap['contractVersion'] = '1.0.0'
    wire_cap['sourceFormatVersion'] = metadata['formatVersion']
    wire_cap['limits'] = {'cpuQuota': 'unavailable_in_v1_allowlist', 'memory': 'raw_cgroup_limit_metrics_when_present'}
    wire_cap['components'] = {}
    output.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    work = Path(tempfile.mkdtemp(prefix='.packaging-', dir=output.parent.parent))
    try:
        components = []
        output_bytes = 0
        csv.field_size_limit(request['maxOutputBytes'])
        envelope = [request[k] for k in ['bundleId', 'serverId', 'sourceEpoch', 'observationGeneration']] + ['0']
        for name in ['jobs', 'numeric_metrics']:
            columns = [f['name'] for f in schemas[name]]
            fields = columns[5:]
            declared = cap['components'].get(name, {})
            if declared.get('schemaVersion') != 1 or declared.get('status') != 'supported' or declared.get('columns') != fields:
                raise ValueError('source_columns_mismatch')
            wire_cap['components'][name] = {**declared, 'columns': columns}
            path = work/(name+'-00000.jsonl.gz')
            count = 0
            with (source/(name+'.csv')).open(encoding='utf-8', newline='') as inp, path.open('wb') as raw:
                rows = csv.reader(inp, strict=True, quoting=csv.QUOTE_NOTNULL)
                if next(rows) != fields:
                    raise ValueError('source_header_mismatch')
                with gzip.GzipFile(filename='', fileobj=raw, mode='wb', mtime=0) as compressed:
                    with io.TextIOWrapper(compressed, encoding='utf-8', newline='') as text:
                        for row in rows:
                            if len(row) != len(fields):
                                raise ValueError('source_row_width_mismatch')
                            values = dict(zip(columns, envelope+row))
                            for field in schemas[name]:
                                if field['type'] == 'BOOLEAN' and values[field['name']] is not None:
                                    values[field['name']] = values[field['name']] == 't'
                            line = canonical(values) + b'\n'
                            output_bytes += len(line)
                            if output_bytes > request['maxOutputBytes']:
                                raise ValueError('bundle_output_budget_exceeded')
                            text.write(line.decode())
                            count += 1
            if type(metadata['rows'].get(name)) is not int or count != metadata['rows'][name]:
                raise ValueError('source_count_mismatch')
            if name == 'jobs' and count > request['maxRows']:
                raise ValueError('source_row_budget_exceeded')
            data = path.read_bytes()
            components.append({'name': name, 'schemaVersion': 1, 'status': 'complete', 'rows': count,
                'parts': [{'partIndex': 0, 'file': path.name, 'rows': count, 'compressedBytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()}]})
        capbytes = canonical(wire_cap)
        (work/'capabilities.json').write_bytes(capbytes)
        manifest = {'contractVersion': '1.0.0', **{k: request[k] for k in ['bundleId', 'serverId', 'sourceEpoch', 'observationGeneration', 'selection']},
            'observedAt': metadata['observedAt'], 'requestedComponents': ['jobs','numeric_metrics'], 'components': components,
            'source': {**{k: cap[k] for k in ['galaxyRelease','postgresqlVersion','gxadminVersion','exporterBuild','timestampInterpretation']},
                'capabilitiesSha256': hashlib.sha256(capbytes).hexdigest(), 'snapshotId': metadata['snapshotId']}}
        (work/'manifest.json').write_bytes(canonical(manifest))
        if sum(f.stat().st_size for f in work.iterdir()) > request['maxOutputBytes']:
            raise ValueError('bundle_output_budget_exceeded')
        for file in work.iterdir():
            with file.open('rb') as out:
                os.fsync(out.fileno())
        fd = os.open(work, os.O_RDONLY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)
        os.rename(work, output)
        fd = os.open(output.parent, os.O_RDONLY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)
    finally:
        if work.exists():
            shutil.rmtree(work)


class Collector:
    def __init__(self, c, api=None):
        self.c = c
        self.root = Path(c['stateDirectory'])
        self.root.mkdir(parents=True, exist_ok=True, mode=0o700)
        if self.root.is_symlink() or self.root.stat().st_mode & 0o077:
            raise ValueError('state_directory_must_be_private')
        self.lock = (self.root/'lock').open('a')
        try:
            fcntl.flock(self.lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            self.lock.close()
            raise
        self.api = api or BigQuery(c)
        path = self.root/'state.json'
        self.state = json.loads(path.read_text()) if path.exists() else {'version': 1, 'serverId': c['serverId'], 'sourceEpoch': c['sourceEpoch'], 'nextGeneration': '1', 'pending': [], 'pendingJobs': [], 'checkpoint': None}
        if (self.state['serverId'], self.state['sourceEpoch']) != (c['serverId'], c['sourceEpoch']):
            raise ValueError('state_source_identity_mismatch')
        self.schema = table_schemas()

    def save(self):
        atomic(self.root/'state.json', self.state)

    def table(self, dataset, name):
        return f"`{self.c['projectId']}.{dataset}.{name}`"

    def receipt(self, manifest, sha):
        rows = self.api.query(f"SELECT status FROM {self.table(self.c['centralDataset'],'org_receipts')} WHERE server_id=@server AND source_epoch=@epoch AND bundle_id=@id AND manifest_sha256=@sha", {'server': self.c['serverId'], 'epoch': self.c['sourceEpoch'], 'id': manifest['bundleId'], 'sha': sha})
        statuses = {r['status'] for r in rows}
        if statuses - {'accepted', 'rejected'} or len(statuses) > 1:
            raise ValueError('ambiguous_acceptance_receipt')
        return next(iter(statuses)) if statuses else None

    def loaded(self, bundle, table, part_index, path, schema, source_format='NEWLINE_DELIMITED_JSON'):
        state_path = bundle/'upload-state.json'
        state = json.loads(state_path.read_text()) if state_path.exists() else {}
        key = table + '-' + str(part_index)
        entry = state.setdefault(key, {'attempt': 0})
        sha = hashlib.sha256(path.read_bytes()).hexdigest()
        if entry.get('sha256', sha) != sha:
            raise ValueError('immutable_spool_changed')
        for _ in range(3):
            if entry['attempt'] > 100:
                raise ValueError('load_attempt_budget_exhausted')
            entry['sha256'] = sha
            job_id = ('gxrdb_' + bundle.name.replace('-', '') + '_' + table + '_' + str(part_index) + '_a' + str(entry['attempt']) + '_h' + sha)
            entry['jobId'] = job_id
            atomic(state_path, state)
            job = self.api.wait(job_id)
            if job is None:
                job = self.api.load(path, table, schema, job_id, source_format)
            if job is None:
                raise ValueError('load_response_unknown')
            if job['status'].get('errorResult'):
                # Only a confirmed failed atomic load permits a new attempt ID.
                entry.pop('jobId', None)
                entry['attempt'] += 1
                atomic(state_path, state)
                continue
            return {'component': table, 'partIndex': part_index, 'jobId': job_id, 'attempt': entry['attempt'], 'sha256': sha}
        raise ValueError('load_attempt_budget_exhausted')

    def upload(self, bundle):
        raw = (bundle/'manifest.json').read_bytes()
        m = json.loads(raw)
        sha = hashlib.sha256(raw).hexdigest()
        status = self.receipt(m, sha)
        if status == 'rejected':
            raise ValueError('bundle_rejected')
        if status == 'accepted':
            return True
        parts = []
        for component in m['components']:
            for part in component['parts']:
                p = bundle/part['file']
                if p.stat().st_size != part['compressedBytes'] or hashlib.sha256(p.read_bytes()).hexdigest() != part['sha256']:
                    raise ValueError('immutable_spool_changed')
                parts.append(self.loaded(bundle, component['name'], part['partIndex'], p, self.schema[component['name']], source_format='NEWLINE_DELIMITED_JSON'))
        submission = bundle/'submission.jsonl'
        if not submission.exists():
            row = {'bundle_id': m['bundleId'], 'server_id': m['serverId'], 'source_epoch': m['sourceEpoch'], 'observation_generation': m['observationGeneration'],
                'manifest_json': raw.decode(), 'submitted_at': m['observedAt'],
                'transport_json': json.dumps({'capabilitiesJson': (bundle/'capabilities.json').read_text(), 'parts': parts}, sort_keys=True, separators=(',', ':'))}
            with submission.open('wb') as f:
                f.write(canonical(row) + b'\n'); f.flush(); os.fsync(f.fileno())
        self.loaded(bundle, 'manifests', 0, submission, self.schema['manifests'], source_format='NEWLINE_DELIMITED_JSON')
        return self.receipt(m, sha) == 'accepted'

    def checkpoint(self, bundle):
        m = json.loads((bundle/'manifest.json').read_text())
        pending = set(self.state['pendingJobs'])
        s = m['selection']
        if s['mode'] == 'id_list':
            pending.difference_update(s['ids'])
        else:
            pending = {x for x in pending if not number(s['lowExclusive']) < number(x) <= number(s['highInclusive'])}
        component = next((x for x in m.get('components', []) if x['name'] == 'jobs'), None)
        paths = [bundle/p['file'] for p in component['parts']] if component else [bundle/'jobs-00000.jsonl.gz']
        for path in paths:
            with gzip.open(path, 'rt', newline='') as f:
                rows = map(json.loads, f)
                for row in rows:
                    if row['state_raw'] not in TERMINAL:
                        pending.add(row['job_id'])
        if len(pending) > self.c['maxPendingJobs']:
            raise ValueError('pending_jobs_budget_exceeded')
        self.state['pendingJobs'] = sorted(pending, key=number)
        self.state['checkpoint'] = {'bundleId': m['bundleId'], 'observationGeneration': m['observationGeneration'], 'selection': s, 'coverageVerified': False}
        self.state['pending'].remove(m['bundleId'])
        self.save()
        archive = self.root/'accepted'
        archive.mkdir(mode=0o700, exist_ok=True)
        os.replace(bundle, archive/bundle.name)
        os.utime(archive/bundle.name, None)

    def retry_rejected(self, identity):
        if identity not in self.state['pending']:
            raise ValueError('unknown_pending_bundle')
        bundle = self.root/'spool'/identity
        archived = self.root/'rejected'/identity
        if not bundle.exists() and archived.exists():
            bundle = archived
        raw = (bundle/'manifest.json').read_bytes()
        manifest = json.loads(raw)
        if self.receipt(manifest, hashlib.sha256(raw).hexdigest()) != 'rejected':
            raise ValueError('only_rejected_bundles_can_be_retried')
        archive = self.root/'rejected'
        archive.mkdir(mode=0o700, exist_ok=True)
        if bundle != archive/identity:
            os.replace(bundle, archive/identity)
        self.state['pending'].remove(identity)
        self.save()
        # Re-extraction always gets a new identity/generation. Old files remain.
        return manifest['selection']

    def recover_and_upload(self):
        # Apply receipts in generation order, so delayed older pending-job
        # observations cannot reverse a newer checkpoint or terminal transition.
        ready = []
        for identity in list(self.state['pending']):
            self.api.check_time()
            bundle = self.root/'spool'/identity
            if not bundle.exists() and (self.root/'rejected'/identity).exists():
                raise ValueError('rejected_retry_interrupted_use_retry_rejected')
            if not bundle.exists():
                request = json.loads((self.root/'requests'/(identity+'.json')).read_text())
                source = self.root/'source'/identity
                source_request = {k: request[k] for k in ['timestampInterpretation','selection','maxRows','maxOutputBytes','maxRuntimeSeconds']}
                source_request['maxRangeWidth'] = self.c.get('maxRangeWidth', 50000)
                request_path = self.root/'requests'/(identity+'.source.json')
                atomic(request_path, source_request)
                if not source.exists():
                    log = self.root/(identity+'.export.log')
                    with log.open('ab') as out:
                        proc = subprocess.Popen([self.c['gxadmin'], 'galaxy', 'export-job-observations', str(request_path), str(source)], stdout=out, stderr=out, start_new_session=True)
                        try:
                            result = proc.wait(timeout=max(1,self.api.deadline-time.monotonic()))
                        except subprocess.TimeoutExpired:
                            os.killpg(proc.pid,signal.SIGTERM)
                            try:
                                proc.wait(timeout=5)
                            except subprocess.TimeoutExpired:
                                os.killpg(proc.pid,signal.SIGKILL);proc.wait()
                            raise ValueError('source_run_budget_exceeded') from None
                        if result:
                            raise ValueError('source_export_failed')
                package_source(source, bundle, request, self.schema)
                shutil.rmtree(source)
            ready.append((bundle, self.upload(bundle)))
        for bundle, accepted in ready:
            if not accepted:
                break
            self.checkpoint(bundle)

    def clean(self):
        # These are unfinished packaging attempts; the immutable source snapshot
        # remains available until the final bundle is durably renamed.
        for partial in self.root.glob('.packaging-*'):
            if partial.is_dir():
                shutil.rmtree(partial)
        archive = self.root/'accepted'
        if archive.exists():
            for p in archive.iterdir():
                if p.is_dir() and re.fullmatch(r'[0-9a-f-]{36}',p.name) and time.time()-p.stat().st_mtime >= self.c['acceptedGraceSeconds']:
                    shutil.rmtree(p)
                    self.remove_auxiliary(p.name)
        # A crash after checkpoint commit can leave acknowledged files in spool.
        for p in (self.root/'spool').glob('*') if (self.root/'spool').exists() else []:
            if p.is_dir() and p.name not in self.state['pending']:
                m = json.loads((p/'manifest.json').read_text())
                if self.receipt(m, hashlib.sha256((p/'manifest.json').read_bytes()).hexdigest()) == 'accepted':
                    shutil.rmtree(p)
                    self.remove_auxiliary(p.name)

    def remove_auxiliary(self, identity):
        (self.root/'requests'/(identity+'.json')).unlink(missing_ok=True)
        (self.root/'requests'/(identity+'.source.json')).unlink(missing_ok=True)
        source = self.root/'source'/identity
        if source.exists():
            shutil.rmtree(source)
        (self.root/(identity+'.export.log')).unlink(missing_ok=True)

    def collect(self, selection=None):
        self.clean()
        self.recover_and_upload()
        if selection is None:
            return
        if any(json.loads((self.root/'requests'/(x+'.json')).read_text())['selection'] == selection for x in self.state['pending']):
            return
        size = sum(p.stat().st_size for p in self.root.rglob('*') if p.is_file())
        if len(self.state['pending']) >= self.c['maxPendingBundles'] or size + 2*self.c['maxOutputBytes'] + 2097152 > self.c['maxSpoolBytes']:
            raise ValueError('spool_budget_exhausted')
        tables = [(self.c['centralDataset'], 'org_receipts'), (self.c['intakeDataset'], 'manifests'), (self.c['intakeDataset'], 'jobs'), (self.c['intakeDataset'], 'numeric_metrics')]
        union = ' UNION ALL '.join(f"SELECT observation_generation FROM {self.table(ds,t)} WHERE server_id=@server AND source_epoch=@epoch" for ds,t in tables)
        maximum = self.api.query('SELECT CAST(COALESCE(MAX(observation_generation),0) AS STRING) AS generation FROM ('+union+')', {'server': self.c['serverId'], 'epoch': self.c['sourceEpoch']})
        generation = max(number(self.state['nextGeneration']), number(maximum[0]['generation'])+1)
        if generation >= MAX_INT64:
            raise ValueError('generation_exhausted')
        identity = str(uuid.uuid4())
        request = {k: self.c[k] for k in ['serverId','sourceEpoch','timestampInterpretation','maxRows','maxOutputBytes']}
        request.update(bundleId=identity, observationGeneration=str(generation), selection=selection, maxRuntimeSeconds=min(self.c['maxRuntimeSeconds'],600))
        atomic(self.root/'requests'/(identity+'.json'),request)
        self.state['nextGeneration'] = str(generation+1)
        self.state['pending'].append(identity)
        self.save()
        self.recover_and_upload()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('config')
    parser.add_argument('--selection')
    parser.add_argument('--retry-rejected')
    args = parser.parse_args()
    c = configuration(args.config)
    collector = Collector(c)
    selection = collector.retry_rejected(args.retry_rejected) if args.retry_rejected else None
    collector.collect(json.loads(Path(args.selection).read_text()) if args.selection else selection)
    print(json.dumps({'status': 'awaiting_acceptance' if collector.state['pending'] else 'acknowledged', 'pendingBundles': len(collector.state['pending']), 'pendingJobs': len(collector.state['pendingJobs'])}))


if __name__ == '__main__':
    try:
        main()
    except Exception as exc:
        print(str(exc), file=sys.stderr)
        sys.exit(1)

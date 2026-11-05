#!/usr/bin/env python3
"""Durable bounded job-observation collection. No source SQL or local database."""
import argparse
import csv
import fcntl
import gzip
import hashlib
import json
import os
from pathlib import Path
import random
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
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
        ('maxSpoolBytes', 268435456, 16777216, 10737418240), ('maxOutputBytes', 16777216, 1024, 1073741824),
        ('maxRows', 500, 1, 50000), ('maxPendingBundles', 4, 1, 100), ('maxPendingJobs', 50000, 1, 1000000),
        ('maxRuntimeSeconds', 600, 1, 3600), ('acceptedGraceSeconds', 3600, 0, 604800),
    ]:
        c.setdefault(key, default)
        if type(c[key]) is not int or not minimum <= c[key] <= maximum:
            raise ValueError('invalid_budget')
    c.setdefault('location', 'US')
    c.setdefault('maximumBytesBilled', '104857600')
    number(c['maximumBytesBilled'])
    c.setdefault('gxadmin', 'gxadmin')
    c.setdefault('tokenCommand', ['gcloud', 'auth', 'print-access-token'])
    if not isinstance(c['tokenCommand'], list) or not all(isinstance(x, str) for x in c['tokenCommand']):
        raise ValueError('invalid_token_command')
    return c


class APIError(Exception):
    def __init__(self, status):
        self.status = status
        super().__init__('bigquery_http_' + str(status))


class BigQuery:
    def __init__(self, c):
        self.c = c
        self.deadline = time.monotonic() + c['maxRuntimeSeconds']
        self.remaining = int(c['maximumBytesBilled'])
        self.token = None
        self.token_until = 0

    def check_time(self):
        if time.monotonic() >= self.deadline:
            raise ValueError('run_budget_exceeded')

    def call(self, method, path, data=None, content_type='application/json', upload=False):
        base = 'https://bigquery.googleapis.com/' + ('upload/' if upload else '') + 'bigquery/v2/'
        for attempt in range(3):
            self.check_time()
            if time.monotonic() > self.token_until:
                p = subprocess.run(self.c['tokenCommand'], capture_output=True, check=True, timeout=30)
                self.token = p.stdout.decode().strip()
                self.token_until = time.monotonic() + 240
                if not self.token:
                    raise ValueError('missing_access_token')
            body = data if isinstance(data, bytes) else (canonical(data) if data is not None else None)
            req = urllib.request.Request(base + path, method=method, data=body,
                headers={'Authorization': 'Bearer ' + self.token, 'Content-Type': content_type})
            try:
                with urllib.request.urlopen(req, timeout=min(60, max(1, self.deadline-time.monotonic()))) as response:
                    return json.load(response)
            except urllib.error.HTTPError as exc:
                # Error bodies can quote private source rows. Never log them.
                if exc.code == 401:
                    self.token_until = 0
                elif exc.code not in [408, 429, 500, 502, 503, 504]:
                    raise APIError(exc.code) from None
            except (urllib.error.URLError, TimeoutError):
                pass
            time.sleep(min(2 ** attempt + random.random(), 5))
        raise ValueError('transport_retry_exhausted')

    def job(self, job_id):
        try:
            return self.call('GET', f"projects/{self.c['projectId']}/jobs/{job_id}?location={self.c['location']}")
        except APIError as e:
            if e.status == 404:
                return None
            raise

    def wait(self, job_id):
        while True:
            job = self.job(job_id)
            if job is None:
                return None
            if job['status']['state'] == 'DONE':
                return job
            self.check_time()
            time.sleep(1)

    def query(self, sql, params=None):
        if self.remaining <= 0:
            raise ValueError('query_budget_exceeded')
        job_id = 'gxrdb_read_' + uuid.uuid4().hex
        config = {'query': sql, 'useLegacySql': False, 'maximumBytesBilled': str(self.remaining), 'parameterMode': 'NAMED',
            'queryParameters': [{'name': k, 'parameterType': {'type': 'STRING'}, 'parameterValue': {'value': v}} for k, v in (params or {}).items()]}
        self.call('POST', f"projects/{self.c['projectId']}/jobs", {'jobReference': {'projectId': self.c['projectId'], 'jobId': job_id, 'location': self.c['location']}, 'configuration': {'query': config}})
        job = self.wait(job_id)
        if not job or job['status'].get('errorResult'):
            raise ValueError('receipt_query_failed')
        self.remaining -= int(job.get('statistics', {}).get('query', {}).get('totalBytesBilled', '0'))
        if self.remaining < 0:
            raise ValueError('query_budget_exceeded')
        result = self.call('GET', f"projects/{self.c['projectId']}/queries/{job_id}?location={self.c['location']}&maxResults=1000")
        if result.get('pageToken'):
            raise ValueError('unexpected_receipt_pagination')
        names = [f['name'] for f in result['schema']['fields']]
        return [{name: field.get('v') for name, field in zip(names, row['f'])} for row in result.get('rows', [])]

    def load(self, path, table, schema, job_id, labels, null_marker=None, source_format='CSV'):
        config = {'destinationTable': {'projectId': self.c['projectId'], 'datasetId': self.c['intakeDataset'], 'tableId': table},
            'sourceFormat': source_format, 'schema': {'fields': schema}, 'autodetect': False,
            'writeDisposition': 'WRITE_APPEND', 'createDisposition': 'CREATE_NEVER', 'maxBadRecords': 0,
            'ignoreUnknownValues': False}
        if source_format == 'CSV':
            config.update(skipLeadingRows=1, allowQuotedNewlines=True, allowJaggedRows=False, nullMarker=null_marker, encoding='UTF-8', quote='"', fieldDelimiter=',')
        meta = {'jobReference': {'projectId': self.c['projectId'], 'jobId': job_id, 'location': self.c['location']}, 'configuration': {'load': config, 'labels': labels}}
        boundary = 'gxrdb_' + uuid.uuid4().hex
        body = b'--' + boundary.encode() + b'\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n' + canonical(meta)
        body += b'\r\n--' + boundary.encode() + b'\r\nContent-Type: application/octet-stream\r\n\r\n' + path.read_bytes() + b'\r\n--' + boundary.encode() + b'--\r\n'
        try:
            self.call('POST', f"projects/{self.c['projectId']}/jobs?uploadType=multipart", body, 'multipart/related; boundary=' + boundary, upload=True)
        except APIError as e:
            if e.status != 409:
                raise
        return self.wait(job_id)


def fault(c, name):
    if c.get('environment') == 'development' and os.environ.get('KUI_GXRDB_TEST_CRASH_AT') == name:
        os._exit(75)


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
        self.schema = json.loads((Path(__file__).parent/'schemas/gxrdb-v1.json').read_text())

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

    def loaded(self, bundle, table, part_index, path, schema, marker=None, source_format='CSV'):
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
            job_id = 'gxrdb_' + bundle.name.replace('-', '') + '_' + table + '_' + str(part_index) + '_a' + str(entry['attempt'])
            entry['jobId'] = job_id
            atomic(state_path, state)
            job = self.api.wait(job_id)
            if job is None:
                labels = {'application': 'gxrdb', 'bundle': bundle.name, 'component': table, 'part': str(part_index), 'sha256_0': sha[:32], 'sha256_1': sha[32:]}
                job = self.api.load(path, table, schema, job_id, labels, marker, source_format)
                fault(self.c, 'after_upload_response')
            if job is None:
                raise ValueError('load_response_unknown')
            if job['status'].get('errorResult'):
                # Only a confirmed failed atomic load permits a new attempt ID.
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
                parts.append(self.loaded(bundle, component['name'], part['partIndex'], p, self.schema[component['name']], m['csvNullMarker']))
                fault(self.c, 'after_component_' + component['name'])
        submission = bundle/'submission.jsonl'
        if not submission.exists():
            row = {'bundle_id': m['bundleId'], 'server_id': m['serverId'], 'source_epoch': m['sourceEpoch'], 'observation_generation': m['observationGeneration'],
                'manifest_json': raw.decode(), 'submitted_at': m['observedAt'],
                'transport_json': json.dumps({'capabilitiesJson': (bundle/'capabilities.json').read_text(), 'parts': parts}, sort_keys=True, separators=(',', ':'))}
            with submission.open('wb') as f:
                f.write(canonical(row) + b'\n'); f.flush(); os.fsync(f.fileno())
        fault(self.c, 'before_manifest')
        self.loaded(bundle, 'manifests', 0, submission, self.schema['manifests'], source_format='NEWLINE_DELIMITED_JSON')
        fault(self.c, 'after_manifest')
        return self.receipt(m, sha) == 'accepted'

    def checkpoint(self, bundle):
        m = json.loads((bundle/'manifest.json').read_text())
        pending = set(self.state['pendingJobs'])
        s = m['selection']
        if s['mode'] == 'id_list':
            pending.difference_update(s['ids'])
        else:
            pending = {x for x in pending if not number(s['lowExclusive']) < number(x) <= number(s['highInclusive'])}
        with gzip.open(bundle/'jobs-00000.csv.gz', 'rt', newline='') as f:
            for row in csv.DictReader(f):
                if row['state_raw'] not in TERMINAL:
                    pending.add(row['job_id'])
        if len(pending) > self.c['maxPendingJobs']:
            raise ValueError('pending_jobs_budget_exceeded')
        self.state['pendingJobs'] = sorted(pending, key=number)
        self.state['checkpoint'] = {'bundleId': m['bundleId'], 'observationGeneration': m['observationGeneration'], 'selection': s, 'coverageVerified': False}
        self.state['pending'].remove(m['bundleId'])
        self.save()
        fault(self.c, 'after_checkpoint')
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
                request = self.root/'requests'/(identity+'.json')
                log = self.root/(identity+'.export.log')
                with log.open('ab') as out:
                    proc = subprocess.Popen([self.c['gxadmin'], 'galaxy', 'export-job-observations', str(request), str(bundle)], stdout=out, stderr=out, start_new_session=True)
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
                fault(self.c, 'after_export')
            ready.append((bundle, self.upload(bundle)))
        for bundle, accepted in ready:
            if not accepted:
                break
            self.checkpoint(bundle)

    def clean(self):
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
        request = {k: self.c[k] for k in ['serverId','sourceEpoch','galaxyRelease','timestampInterpretation','maxRows','maxOutputBytes']}
        request.update(bundleId=identity, observationGeneration=str(generation), selection=selection, maxRuntimeSeconds=min(self.c['maxRuntimeSeconds'],1800))
        atomic(self.root/'requests'/(identity+'.json'),request)
        self.state['nextGeneration'] = str(generation+1)
        self.state['pending'].append(identity)
        self.save()
        fault(self.c, 'after_reservation')
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
        # Never log private API error bodies, SQL, source rows or credentials.
        code = str(exc) if isinstance(exc, (ValueError,APIError)) else type(exc).__name__
        print(json.dumps({'status':'failed','reason':code}),file=sys.stderr)
        sys.exit(1)

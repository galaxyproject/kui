import importlib.util
import gzip
import hashlib
import json
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('collector_gxrdb', Path(__file__).with_name('gxrdb.py'))
g = importlib.util.module_from_spec(spec)
spec.loader.exec_module(g)
ID = '00000000-0000-4000-8000-000000000001'


class API:
    def __init__(self):
        self.deadline = time.monotonic()+60
        self.jobs = {}
        self.loads = 0
        self.status = None

    def check_time(self):
        pass

    def query(self, *args):
        return [{'status': self.status}] if self.status else []

    def wait(self, identity):
        return self.jobs.get(identity)

    def load(self, path, table, schema, identity, *args):
        self.loads += 1
        self.jobs[identity] = {'status': {'state': 'DONE'}}
        return self.jobs[identity]


class DurableCollection(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.api = API()
        self.c = {'stateDirectory': str(self.root), 'serverId': 'usegalaxy-org', 'sourceEpoch': 'test',
                  'projectId': 'test-project', 'centralDataset': 'central', 'maxPendingJobs': 100, 'acceptedGraceSeconds': 0}
        self.collector = g.Collector(self.c, self.api)
        self.bundle = self.root/'spool'/ID
        self.bundle.mkdir(parents=True)
        self.manifest = {'bundleId': ID, 'observationGeneration': '9007199254740993',
                         'selection': {'mode': 'id_list', 'ids': ['1','2']}}
        (self.bundle/'manifest.json').write_text(json.dumps(self.manifest))
        with gzip.open(self.bundle/'jobs-00000.jsonl.gz', 'wt') as f:
            f.write(json.dumps({'job_id':'1','state_raw':'ok'})+'\n'+json.dumps({'job_id':'2','state_raw':'running'})+'\n')
        self.collector.state['pending'] = [ID]
        self.collector.state['pendingJobs'] = ['1','3']
        self.collector.save()
        g.atomic(self.root/'requests'/(ID+'.json'), {'selection': self.manifest['selection']})
        (self.root/(ID+'.export.log')).write_text('private log')

    def tearDown(self):
        self.collector.lock.close()
        self.temp.cleanup()

    def test_lost_upload_response_reuses_original_job(self):
        file = self.bundle/'data.jsonl.gz'
        file.write_bytes(b'compressed-test-data')
        def lose_response(*args):
            API.load(self.api, *args)
            raise SystemExit(75)
        with patch.object(self.api, 'load', side_effect=lose_response):
            with self.assertRaises(SystemExit):
                self.collector.loaded(self.bundle,'jobs',0,file,[])
        receipt = self.collector.loaded(self.bundle,'jobs',0,file,[])
        self.assertEqual(self.api.loads, 1)
        self.assertEqual(receipt['attempt'], 0)
        self.assertEqual(receipt['sha256'], hashlib.sha256(file.read_bytes()).hexdigest())
        file.write_bytes(b'changed')
        with self.assertRaisesRegex(ValueError,'immutable_spool_changed'):
            self.collector.loaded(self.bundle,'jobs',0,file,[])

    def test_checkpoint_crash_preserves_progress_and_cleans_auxiliary(self):
        original_replace = g.os.replace
        def interrupt_archive(source, destination):
            if source == self.bundle:
                raise SystemExit(75)
            return original_replace(source, destination)
        with patch.object(g.os, 'replace', side_effect=interrupt_archive):
            with self.assertRaises(SystemExit):
                self.collector.checkpoint(self.bundle)
        saved = json.loads((self.root/'state.json').read_text())
        self.assertEqual(saved['pending'], [])
        self.assertEqual(saved['pendingJobs'], ['2','3'])
        self.assertEqual(saved['checkpoint']['observationGeneration'], '9007199254740993')
        self.assertFalse(saved['checkpoint']['coverageVerified'])
        self.assertTrue(self.bundle.exists())
        self.api.status = 'accepted'
        self.collector.clean()
        self.assertFalse(self.bundle.exists())
        self.assertFalse((self.root/'requests'/(ID+'.json')).exists())
        self.assertFalse((self.root/(ID+'.export.log')).exists())

    def test_rejected_archive_crash_can_resume_without_reusing_identity(self):
        self.api.status = 'rejected'
        with patch.object(self.collector,'save',side_effect=SystemExit(75)):
            with self.assertRaises(SystemExit):
                self.collector.retry_rejected(ID)
        self.assertTrue((self.root/'rejected'/ID).exists())
        # Restore persisted state as a new process would.
        self.collector.state = json.loads((self.root/'state.json').read_text())
        self.assertEqual(self.collector.retry_rejected(ID), self.manifest['selection'])
        self.assertEqual(self.collector.state['pending'], [])
        self.assertIsNone(self.collector.state['checkpoint'])

    def test_rejection_never_advances_checkpoint_or_discards_files(self):
        self.api.status = 'rejected'
        with self.assertRaisesRegex(ValueError,'bundle_rejected'):
            self.collector.upload(self.bundle)
        self.assertEqual(self.collector.state['pending'], [ID])
        self.assertIsNone(self.collector.state['checkpoint'])
        self.assertTrue(self.bundle.exists())

    def test_exclusive_lock_prevents_second_reader(self):
        with self.assertRaises(BlockingIOError):
            g.Collector(self.c,self.api)

    def test_int64_values_are_exact_and_bounded(self):
        self.assertEqual(g.number('9223372036854775807'), 9223372036854775807)
        for value in ['9223372036854775808','01','-1',1,True]:
            with self.assertRaises(ValueError):
                g.number(value)


if __name__ == '__main__':
    unittest.main()

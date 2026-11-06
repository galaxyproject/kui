import csv
import gzip
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import time
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('packaging_collector', Path(__file__).with_name('gxrdb.py'))
g = importlib.util.module_from_spec(spec)
spec.loader.exec_module(g)
ID = '00000000-0000-4000-8000-000000000001'
SCHEMAS = json.loads((Path(__file__).parent/'schemas/gxrdb-v1.json').read_text())


def fixture(source, empty=False):
    source.mkdir(parents=True)
    request = {'serverId': 'usegalaxy-org', 'sourceEpoch': 'test', 'bundleId': ID,
               'observationGeneration': '9007199254740993', 'galaxyRelease': '26.2',
               'timestampInterpretation': 'UTC', 'maxRows': 500, 'maxRuntimeSeconds': 180,
               'maxOutputBytes': 16777216, 'selection': {'entity': 'jobs', 'mode': 'id_list', 'ids': ['195']}}
    marker = '__gxrdb_null_'+ID+'__'
    cap = {'formatVersion': 1, 'galaxyRelease': '26.2', 'postgresqlVersion': '17.2',
           'gxadminVersion': '25-pre', 'exporterBuild': 'fixture-build', 'timestampInterpretation': 'UTC',
           'components': {}, 'numericMetricAllowList': [['cgroup', 'cpuacct.usage']], 'textMetrics': []}
    payloads = {
        'jobs': ['195', '2026-09-01T00:00:00.000000Z', marker, 'ok', 'fixture', 'quote",\nΩ', '', '\\N', '', marker, marker, marker, marker, 'f'],
        'numeric_metrics': ['9223372036854775807', '195', 'cgroup', 'cpuacct.usage', '9007199254740993.1234567'],
    }
    for name, payload in payloads.items():
        columns = [f['name'] for f in SCHEMAS[name]][5:]
        cap['components'][name] = {'schemaVersion': 1, 'status': 'supported', 'columns': columns}
        with (source/(name+'.csv')).open('w', newline='') as out:
            writer = csv.writer(out, lineterminator='\n')
            writer.writerow(columns)
            if not empty:
                writer.writerow(payload)
    metadata = {'formatVersion': 1, 'selection': request['selection'], 'csvNullMarker': marker,
                'observedAt': '2026-11-05T00:00:00.000000Z', 'snapshotId': '1:2:', 'capabilities': cap,
                'rows': {name: 0 if empty else 1 for name in payloads}}
    g.atomic(source/'metadata.json', metadata)
    return request, payloads


class Packaging(unittest.TestCase):
    def test_values_and_retry_bytes_are_preserved(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            request, payloads = fixture(root/'source')
            for target in ['bundle-a', 'bundle-b']:
                g.package_source(root/'source', root/target, request, SCHEMAS)
            self.assertEqual((root/'bundle-a/manifest.json').read_bytes(), (root/'bundle-b/manifest.json').read_bytes())
            m = json.loads((root/'bundle-a/manifest.json').read_text())
            cap = json.loads((root/'bundle-a/capabilities.json').read_text())
            self.assertEqual(cap['sourceFormatVersion'], 1)
            self.assertEqual(cap['limits']['cpuQuota'], 'unavailable_in_v1_allowlist')
            self.assertEqual(hashlib.sha256((root/'bundle-a/capabilities.json').read_bytes()).hexdigest(), m['source']['capabilitiesSha256'])
            for component in m['components']:
                part = component['parts'][0]
                data = (root/'bundle-a'/part['file']).read_bytes()
                self.assertEqual(data, (root/'bundle-b'/part['file']).read_bytes())
                self.assertEqual(hashlib.sha256(data).hexdigest(), part['sha256'])
                with gzip.open(root/'bundle-a'/part['file'], 'rt', newline='') as inp:
                    rows = list(csv.reader(inp))
                self.assertEqual(rows[1][:5], [ID, 'usegalaxy-org', 'test', '9007199254740993', '0'])
                self.assertEqual(rows[1][5:], payloads[component['name']])
            self.assertTrue((root/'source/metadata.json').exists())

    def test_empty_snapshots_remain_complete(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            request, _ = fixture(root/'source', empty=True)
            g.package_source(root/'source', root/'bundle', request, SCHEMAS)
            m = json.loads((root/'bundle/manifest.json').read_text())
            self.assertEqual([c['rows'] for c in m['components']], [0, 0])
            self.assertTrue(all(c['status'] == 'complete' for c in m['components']))

    def test_incomplete_or_mismatched_source_never_finalizes(self):
        for mode in ['count', 'selection', 'columns']:
            with self.subTest(mode=mode), tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp)
                request, _ = fixture(root/'source')
                metadata = json.loads((root/'source/metadata.json').read_text())
                if mode == 'count':
                    metadata['rows']['numeric_metrics'] = 2
                elif mode == 'selection':
                    metadata['selection']['ids'] = ['196']
                else:
                    metadata['capabilities']['components']['jobs']['columns'].reverse()
                g.atomic(root/'source/metadata.json', metadata)
                with self.assertRaises(ValueError):
                    g.package_source(root/'source', root/'bundle', request, SCHEMAS)
                self.assertFalse((root/'bundle').exists())
                self.assertTrue((root/'source/metadata.json').exists())

    def test_crash_after_source_export_reuses_snapshot_without_another_query(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            request, _ = fixture(root/'source'/ID)
            api = type('API', (), {'deadline': time.monotonic()+60, 'check_time': lambda self: None})()
            c = g.Collector({'stateDirectory': str(root), 'serverId': 'usegalaxy-org', 'sourceEpoch': 'test'}, api)
            try:
                c.state['pending'] = [ID]
                g.atomic(root/'requests'/(ID+'.json'), request)
                def crash(config, point):
                    if point == 'after_source_export':
                        raise SystemExit(75)
                with patch.object(g, 'fault', side_effect=crash), patch.object(g.subprocess, 'Popen') as process:
                    with self.assertRaises(SystemExit):
                        c.recover_and_upload()
                    process.assert_not_called()
                (root/'.packaging-interrupted').mkdir()
                (root/'.packaging-interrupted/partial.csv.gz').write_bytes(b'incomplete')
                c.clean()
                self.assertFalse((root/'.packaging-interrupted').exists())
                self.assertTrue((root/'source'/ID/'metadata.json').exists())
                with patch.object(c, 'upload', return_value=False), patch.object(g.subprocess, 'Popen') as process:
                    c.recover_and_upload()
                    process.assert_not_called()
                self.assertTrue((root/'spool'/ID/'manifest.json').exists())
                self.assertFalse((root/'source'/ID).exists())
                self.assertEqual(c.state['pending'], [ID])
                self.assertIsNone(c.state['checkpoint'])
            finally:
                c.lock.close()


if __name__ == '__main__':
    unittest.main()

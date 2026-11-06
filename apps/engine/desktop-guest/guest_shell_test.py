import io
import json
import os
import subprocess
import tempfile
import unittest
from unittest.mock import patch

import guest_shell

REQUEST_ID = 'a' * 32
OTHER_ID = 'b' * 32
HASH = 'a' * 64
LOCK = 'b' * 64


class FakeProcess:
    def __init__(self, behavior='done'):
        self.pid = 4242
        self.returncode = None
        self.behavior = behavior
        self.stdout = io.BytesIO(b'out')
        self.stderr = io.BytesIO(b'err')

    def wait(self, timeout=None):
        if self.behavior == 'timeout' and timeout is not None:
            raise subprocess.TimeoutExpired(cmd='fake', timeout=timeout)
        self.returncode = 1 if self.behavior == 'nonzero' else 0
        if self.behavior == 'timeout':
            self.returncode = None
        return self.returncode


class GuestShellTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.workspace = os.path.join(self.temp.name, 'workspace')
        self.receipts = os.path.join(self.temp.name, 'receipts')
        self.manager = guest_shell.GuestShellManager(self.workspace, self.receipts)
        self.kills = []
        self.launches = []
        self.install = os.path.join(self.temp.name, 'install.json')
        with open(self.install, 'w') as handle:
            json.dump({'packages': [{'package': 'is-number@7.0.0', 'status': 'installed', 'manifestSha256': HASH, 'lockSha256': LOCK}]}, handle)

    def tearDown(self):
        self.temp.cleanup()

    def request(self, **changes):
        return {'requestId': REQUEST_ID, 'command': 'printf ok', 'timeoutMs': 120_000, 'cwd': '', **changes}

    def test_minimal_environment_and_nonzero_exit(self):
        seen = []
        def factory(argv, **kwargs):
            seen.append((argv, kwargs))
            return FakeProcess('nonzero')
        with patch.object(guest_shell.subprocess, 'Popen', factory), patch.object(guest_shell.os, 'killpg', lambda pid, sig: self.kills.append((pid, sig))):
            result = self.manager.execute(self.request())
        self.assertEqual(result['status'], 'failed')
        self.assertEqual(result['exitCode'], 1)
        self.assertEqual(result['stdout'], 'out')
        self.assertEqual(result['stderr'], 'err')
        self.assertEqual(seen[0][0], ['/bin/sh', '-c', 'printf ok'])
        self.assertNotIn('OPENROUTER_API_KEY', seen[0][1]['env'])
        self.assertEqual(seen[0][1]['env']['RERUN_WORKSPACE'], self.workspace)

    def test_duplicate_execution_replays_receipt_not_process(self):
        with patch.object(guest_shell.subprocess, 'Popen', side_effect=lambda *args, **kwargs: self.launches.append(1) or FakeProcess()):
            first = self.manager.execute(self.request())
            second = self.manager.execute(self.request())
        self.assertEqual(first, second)
        self.assertEqual(len(self.launches), 1)
        self.assertEqual(self.manager.inspect(OTHER_ID)['status'], 'unavailable')

    def test_timeout_kills_only_owned_process_group(self):
        with patch.object(guest_shell.subprocess, 'Popen', return_value=FakeProcess('timeout')), patch.object(guest_shell.os, 'killpg', lambda pid, sig: self.kills.append((pid, sig))):
            result = self.manager.execute(self.request(timeoutMs=1))
        self.assertEqual(result['status'], 'timeout')
        self.assertEqual(self.kills, [(4242, guest_shell.signal.SIGKILL)])

    def test_output_cap_is_failure_not_silent_truncation(self):
        process = FakeProcess()
        process.stdout = io.BytesIO(b'x' * (guest_shell.OUTPUT_MAX + 1)
        with patch.object(guest_shell.subprocess, 'Popen', return_value=process), patch.object(guest_shell.os, 'killpg', lambda pid, sig: self.kills.append((pid, sig))):
            result = self.manager.execute(self.request())
        self.assertEqual(result['status'], 'failed')
        self.assertIn('exceeded', result['message'])

    def test_cwd_escape_and_links_are_refused(self):
        with self.assertRaises(guest_shell.GuestShellError):
            self.manager.execute(self.request(cwd='..'))
        outside = os.path.join(self.temp.name, 'outside')
        os.mkdir(outside)
        os.symlink(outside, os.path.join(self.workspace, 'linked'))
        with self.assertRaises(guest_shell.GuestShellError):
            self.manager.execute(self.request(cwd='linked'))

    def test_reviewed_package_evidence(self):
        with patch.object(guest_shell, 'INSTALL_RECEIPT', self.install), patch.object(guest_shell.subprocess, 'Popen', return_value=FakeProcess()):
            result = self.manager.execute(self.request(packages=['is-number@7.0.0']))
        self.assertEqual(result['packageEvidence'], [{'package': 'is-number@7.0.0', 'manifestSha256': HASH, 'lockSha256': LOCK}])
        with self.assertRaises(guest_shell.GuestShellError):
            self.manager.execute(self.request(packages=['missing@1.0.0']))

    def test_cancel_reconciles_receipt(self):
        process = FakeProcess()
        with patch.object(guest_shell.subprocess, 'Popen', return_value=process), patch.object(guest_shell.os, 'killpg', lambda pid, sig: self.kills.append((pid, sig))):
            self.manager.active[REQUEST_ID] = process
            self.manager.partial[REQUEST_ID] = ([b'out'], [b'err'])
            result = self.manager.cancel(REQUEST_ID)
        self.assertEqual(result['status'], 'cancelled')
        self.assertEqual(result['stdout'], 'out')
        self.assertEqual(result['stderr'], 'err')
        self.assertEqual(self.manager.inspect(REQUEST_ID)['status'], 'cancelled')
        self.assertEqual(self.kills, [(4242, guest_shell.signal.SIGKILL)])


if __name__ == '__main__':
    unittest.main()

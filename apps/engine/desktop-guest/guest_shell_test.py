import json
import os
from pathlib import Path
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch
import guest_shell
import tool_install

COMMAND_ID = 'a' * 32
HASH = 'b' * 64

class GuestShellTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.workspace = Path(self.temp.name) / 'workspace'
        self.receipts = Path(self.temp.name) / 'receipts'
        self.workspace_patch = patch.object(tool_install, 'WORKSPACE', self.workspace)
        self.journal_patch = patch.object(tool_install, 'JOURNAL', Path(self.temp.name) / 'install')
        self.workspace_patch.start(); self.journal_patch.start()
        self.fingerprint = tool_install.initialize()
        self.manager = guest_shell.GuestShellManager(str(self.workspace), str(self.receipts))
    def tearDown(self):
        self.workspace_patch.stop(); self.journal_patch.stop(); self.temp.cleanup()
    def request(self, **changes):
        return {'op': 'guest-shell', 'requestId': 'f' * 32, 'commandId': COMMAND_ID, 'workspaceFingerprint': self.fingerprint, 'fingerprint': HASH, 'command': 'printf ok', 'timeoutMs': 2000, 'cwd': '', **changes}
    def inspect_request(self):
        return {'op': 'guest-shell-inspect', 'requestId': 'e' * 32, 'commandId': COMMAND_ID, 'workspaceFingerprint': self.fingerprint}
    def test_cwd_escape_and_links_are_refused(self):
        for cwd in ('..', '/etc', 'a//b', 'a/./b', 'a\\b'):
            with self.assertRaises(guest_shell.GuestShellError):
                self.manager.execute(self.request(cwd=cwd))
        outside = Path(self.temp.name) / 'outside'; outside.mkdir()
        (self.workspace / 'linked').symlink_to(outside)
        with self.assertRaises(guest_shell.GuestShellError):
            self.manager.execute(self.request(cwd='linked'))
    def test_receipts_are_authenticated_and_removed_receipts_never_reexecute(self):
        self.manager.write(COMMAND_ID, HASH, guest_shell.empty(COMMAND_ID, 'interrupted', 'reserved'))
        self.manager.path(COMMAND_ID).unlink()
        with patch.object(guest_shell.subprocess, 'Popen') as launch:
            with self.assertRaises(guest_shell.GuestShellError):
                self.manager.execute(self.request())
            launch.assert_not_called()
        self.manager.path(COMMAND_ID).write_text(json.dumps({'payload': {'result': {'requestId': COMMAND_ID, 'status': 'done'}}, 'mac': '0' * 64}))
        with self.assertRaises(guest_shell.GuestShellError):
            self.manager.inspect(self.inspect_request())
    def test_new_process_cannot_adopt_unsigned_or_old_guest_receipts(self):
        self.manager.write(COMMAND_ID, HASH, guest_shell.empty(COMMAND_ID, 'interrupted', 'reserved'))
        restarted = guest_shell.GuestShellManager(str(self.workspace), str(self.receipts))
        with patch.object(guest_shell.subprocess, 'Popen') as launch:
            with self.assertRaises(guest_shell.GuestShellError):
                restarted.execute(self.request())
            launch.assert_not_called()
    def test_inspect_missing_and_cancel_unknown_do_not_claim_success(self):
        self.assertEqual(self.manager.inspect(self.inspect_request())['status'], 'unavailable')
        self.assertEqual(list(self.receipts.iterdir()), [])
        with self.assertRaises(guest_shell.GuestShellError):
            self.manager.cancel({**self.inspect_request(), 'op': 'guest-shell-cancel'})
    def test_package_evidence_uses_canonical_install_files_and_exact_host_hashes(self):
        expected = [{'package': 'is-number@7.0.0', 'manifestSha256': 'c' * 64, 'lockSha256': 'd' * 64}]
        with patch.object(tool_install, 'evidence', return_value=[{**expected[0], 'status': 'installed'}]):
            self.assertEqual(guest_shell.package_evidence(expected), expected)
        with patch.object(tool_install, 'evidence', return_value=[{**expected[0], 'status': 'installed', 'lockSha256': 'e' * 64}]):
            with self.assertRaises(guest_shell.GuestShellError):
                guest_shell.package_evidence(expected)
    @unittest.skipUnless(sys.platform == 'linux', 'Runs in the isolated Linux guest; root owns Docker QA')
    def test_real_command_replay_and_nonzero_exit(self):
        first = self.manager.execute(self.request(command='printf ok; printf err >&2; exit 7'))
        self.assertEqual((first['status'], first['stdout'], first['stderr'], first['exitCode']), ('failed', 'ok', 'err', 7))
        with patch.object(guest_shell.subprocess, 'Popen') as launch:
            self.assertEqual(self.manager.execute(self.request(command='printf ok; printf err >&2; exit 7')), first)
            launch.assert_not_called()
        self.assertEqual(self.manager.inspect(self.inspect_request()), first)
    @unittest.skipUnless(sys.platform == 'linux', 'Requires Linux child subreaper')
    def test_timeout_and_output_limit_are_bounded_and_keep_their_status(self):
        result = self.manager.execute(self.request(command='sleep 30', timeoutMs=100))
        self.assertEqual(result['status'], 'timeout'); self.assertIsNone(result['exitCode'])
        result = self.manager.execute(self.request(commandId='b' * 32, command="python3 -c 'print(\"x\" * 200000)'"))
        self.assertEqual(result['status'], 'failed'); self.assertLessEqual(len(result['stdout']), guest_shell.OUTPUT_MAX)
        self.assertIn('exceeded', result['message'])
    @unittest.skipUnless(sys.platform == 'linux', 'Requires Linux child subreaper')
    def test_detached_background_child_is_drained_after_parent_success(self):
        command = "python3 -c 'import os,time; os.setsid(); open(\"child.pid\",\"w\").write(str(os.getpid())); time.sleep(30)' & sleep 0.2"
        result = self.manager.execute(self.request(command=command))
        self.assertEqual(result['status'], 'done')
        pid = int((self.workspace / 'child.pid').read_text())
        self.assertFalse(Path(f'/proc/{pid}').exists())
    @unittest.skipUnless(sys.platform == 'linux', 'Requires Linux child subreaper')
    def test_cancel_waits_for_execution_writer_and_preserves_cancelled_receipt(self):
        outputs = []
        thread = threading.Thread(target=lambda: outputs.append(self.manager.execute(self.request(command='echo started > started; sleep 30'))))
        thread.start()
        deadline = time.monotonic() + 5
        while not (self.workspace / 'started').exists() and time.monotonic() < deadline:
            time.sleep(0.01)
        self.assertTrue((self.workspace / 'started').exists())
        ack = self.manager.cancel({**self.inspect_request(), 'op': 'guest-shell-cancel'})
        thread.join(timeout=5)
        self.assertFalse(thread.is_alive()); self.assertTrue(ack['drained'])
        self.assertEqual(outputs[0]['status'], 'cancelled')
        self.assertEqual(self.manager.inspect(self.inspect_request())['status'], 'cancelled')

if __name__ == '__main__':
    unittest.main()

"""Offline authored regressions; root runs these, never npm on the host."""
import importlib.util
import json
import os
import pathlib
import tempfile
import unittest
from unittest.mock import Mock, patch
spec = importlib.util.spec_from_file_location('install_fixture', pathlib.Path(__file__).with_name('tool_install.py'))
install = importlib.util.module_from_spec(spec)
spec.loader.exec_module(install)

class ReviewedInstallation(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = pathlib.Path(self.temp.name)
        self.paths = patch.multiple(install, WORKSPACE=self.root / 'workspace', JOURNAL=self.root / 'journal')
        self.paths.start()
        self.fingerprint = install.initialize()
        self.request = {'op': 'tool-install', 'mode': 'install', 'operationId': 'a' * 64, 'workspaceFingerprint': self.fingerprint, 'packages': ['left-pad@1.2.3']}
    def tearDown(self):
        self.paths.stop()
        self.temp.cleanup()
    def test_invalid_target_cannot_reach_a_process(self):
        with patch.object(install.subprocess, 'Popen') as process:
            for target in ['--prefix=/etc', 'pkg@latest', 'https://example.com/pkg', '../pkg@1.0.0']:
                with self.assertRaises(install.InstallError):
                    install.dispatch({**self.request, 'packages': [target]}, None, lambda _: False)
            process.assert_not_called()
    def test_inspect_without_submission_never_installs_or_claims_success(self):
        with patch.object(install.subprocess, 'Popen') as process:
            result = install.dispatch({**self.request, 'mode': 'inspect'}, None, lambda _: False)
            self.assertEqual(result['result']['status'], 'failed')
            process.assert_not_called()
    def test_lost_ack_submission_is_never_executed_again(self):
        identity = {key: self.request[key] for key in ['operationId', 'workspaceFingerprint', 'packages']}
        install.seal_receipt(install.JOURNAL / ('a' * 64 + '.json'), {'identity': identity, 'phase': 'submitted'})
        with patch.object(install.subprocess, 'Popen') as process:
            result = install.dispatch(self.request, None, lambda _: False)
            self.assertEqual(result['result']['status'], 'uncertain')
            process.assert_not_called()
            with self.assertRaises(install.InstallError):
                install.dispatch({**self.request, 'packages': ['left-pad@1.2.4']}, None, lambda _: False)
    def test_unverified_replacement_journal_cannot_admit_or_complete_an_install(self):
        identity = {key: self.request[key] for key in ['operationId', 'workspaceFingerprint', 'packages']}
        install.atomic(install.JOURNAL / ('a' * 64 + '.json'), {'identity': identity, 'phase': 'submitted'})
        with patch.object(install.subprocess, 'Popen') as process:
            with self.assertRaises(install.InstallError):
                install.dispatch(self.request, None, lambda _: False)
            process.assert_not_called()
    def test_replacement_workspace_is_not_adopted(self):
        with patch.object(install.subprocess, 'Popen') as process:
            with self.assertRaises(install.InstallError):
                install.dispatch({**self.request, 'workspaceFingerprint': 'f' * 64}, None, lambda _: False)
            process.assert_not_called()
    def test_evidence_is_read_from_exact_manifest_lock_and_installed_version(self):
        install.atomic(install.WORKSPACE / 'package.json', {'dependencies': {'left-pad': '^1.2.3'}})
        install.atomic(install.WORKSPACE / 'package-lock.json', {'packages': {'node_modules/left-pad': {'version': '1.2.3'}}})
        folder = install.WORKSPACE / 'node_modules' / 'left-pad'
        folder.mkdir(parents=True)
        install.atomic(folder / 'package.json', {'name': 'left-pad', 'version': '1.2.3'})
        result = install.evidence(['left-pad@1.2.3'])
        self.assertEqual(result[0]['status'], 'installed')
        self.assertEqual(len(result[0]['manifestSha256']), 64)
        install.atomic(folder / 'package.json', {'name': 'left-pad', 'version': '2.0.0'})
        self.assertEqual(install.evidence(['left-pad@1.2.3'])[0]['status'], 'uncertain')
    def test_install_uses_literal_command_and_seals_real_evidence(self):
        install.atomic(install.WORKSPACE / 'package.json', {'dependencies': {'left-pad': '^1.2.3'}})
        install.atomic(install.WORKSPACE / 'package-lock.json', {'packages': {'node_modules/left-pad': {'version': '1.2.3'}}})
        folder = install.WORKSPACE / 'node_modules' / 'left-pad'
        folder.mkdir(parents=True)
        install.atomic(folder / 'package.json', {'name': 'left-pad', 'version': '1.2.3'})
        read_fd, write_fd = os.pipe()
        os.close(write_fd)
        process = Mock(pid=123456, stdout=os.fdopen(read_fd, 'rb'), returncode=0)
        process.poll.return_value = 0
        with patch.object(install.subprocess, 'Popen', return_value=process) as spawn, patch.object(install.os, 'killpg'):
            result = install.dispatch(self.request, None, lambda _: False)
            self.assertEqual(result['result']['status'], 'installed')
            self.assertEqual(spawn.call_args.args[0], ['/usr/bin/npm', 'install', '--no-fund', '--no-audit', '--', 'left-pad@1.2.3'])
            self.assertFalse(spawn.call_args.kwargs['shell'])
            self.assertEqual(spawn.call_args.kwargs['cwd'], install.WORKSPACE)
            self.assertEqual(install.dispatch(self.request, None, lambda _: False), result)
            spawn.assert_called_once()
    def test_cancel_during_subprocess_kills_and_waits_before_receipt(self):
        read_fd, write_fd = os.pipe()
        os.close(write_fd)
        process = Mock(pid=123456, stdout=os.fdopen(read_fd, 'rb'), returncode=-9)
        process.poll.return_value = None
        checks = iter([False, False, True])
        with patch.object(install.subprocess, 'Popen', return_value=process), patch.object(install.os, 'killpg') as kill:
            result = install.dispatch(self.request, None, lambda _: next(checks))
            self.assertEqual(result['result']['status'], 'uncertain')
            kill.assert_called_with(123456, install.signal.SIGKILL)
            process.wait.assert_called()

    def test_cancel_before_submission_keeps_journal_and_process_empty(self):
        with patch.object(install.subprocess, 'Popen') as process:
            with self.assertRaises(install.InstallError):
                install.dispatch(self.request, None, lambda _: True)
            process.assert_not_called()
            self.assertEqual(list(install.JOURNAL.glob('*.json')), [])

if __name__ == '__main__':
    unittest.main()

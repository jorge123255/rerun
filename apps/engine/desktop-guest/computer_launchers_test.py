"""Fake-only regression sources. Root executes these; no guest apps are started here."""
import unittest
from unittest.mock import Mock, patch
import computer_launchers as launchers


class LauncherTests(unittest.TestCase):
    def request(self, **extra):
        return dict(op='computer-launcher', operationId='a'*64, fingerprint='b'*64,
                    app='terminal', mode='launch', **extra)

    def manager(self):
        manager = launchers.GuestComputerLaunchers('c'*64, lambda: {'DISPLAY': ':1', 'HOME': '/home/rerun', 'TOKEN': 'fixture-excluded'}, lambda _: False)
        manager._read = Mock(return_value=None)
        manager._write = Mock()
        manager._windows = Mock(return_value=[])
        manager._activate = Mock()
        return manager

    def test_fixed_vectors_have_no_host_paths_shell_or_request_text(self):
        self.assertEqual(launchers.launch_vector('files'), ['/usr/bin/thunar', '/home/rerun/workspace'])
        self.assertEqual(launchers.launch_vector('terminal'), ['/usr/bin/xfce4-terminal', '--working-directory=/home/rerun/workspace'])
        for value in ('browser', '/bin/sh', 'terminal;id', 'Finder'):
            with self.assertRaises(launchers.LauncherError):
                launchers.launch_vector(value)

    def test_unknown_fields_and_host_paths_are_refused_before_effects(self):
        for key in ('command', 'url', 'args', 'env', 'cwd', 'path', 'owner', 'generation'):
            with self.assertRaises(launchers.LauncherError):
                launchers.parse_request(self.request(**{key: '/Users/private'}))

    def test_environment_excludes_credentials_and_native_runtime(self):
        env = self.manager()._environment()
        self.assertEqual(env['DISPLAY'], ':1')
        self.assertNotIn('TOKEN', env)
        self.assertNotIn('RERUN_API_KEY', env)
        self.assertNotIn('DBUS_SESSION_BUS_ADDRESS', env)

    @patch.object(launchers, 'check_directory', return_value=(1, 2))
    def test_existing_last_owned_window_is_focused_without_spawn(self, _):
        manager = self.manager()
        windows = [{'windowId': '11', 'pid': 1, 'start': '10'}, {'windowId': '22', 'pid': 2, 'start': '11'}]
        manager._windows.return_value = windows
        with patch.object(launchers.Path, 'iterdir', return_value=iter([])), patch.object(launchers.subprocess, 'Popen') as spawn:
            result = manager.dispatch(self.request(), None)
        self.assertEqual(result['status'], 'focused')
        manager._activate.assert_called_once_with(windows[-1], 'terminal', None, unittest.mock.ANY)
        spawn.assert_not_called()

    @patch.object(launchers, 'check_directory', return_value=(1, 2))
    def test_restart_reconcile_without_record_never_spawns(self, _):
        manager = self.manager()
        request = self.request(); request['mode'] = 'reconcile'
        with patch.object(launchers.subprocess, 'Popen') as spawn:
            self.assertEqual(manager.dispatch(request, None)['status'], 'interrupted')
        spawn.assert_not_called()

    @patch.object(launchers, 'check_directory', return_value=(1, 2))
    def test_same_attempt_reconciles_exact_window_and_changed_input_refuses(self, _):
        manager = self.manager()
        window = {'windowId': '12', 'pid': 1, 'start': '10'}
        manager._read.return_value = {'fingerprint': 'b'*64, 'app': 'terminal', 'window': window}
        manager._window = Mock(return_value=window)
        with patch.object(launchers.subprocess, 'Popen') as spawn:
            self.assertEqual(manager.dispatch(self.request(), None)['status'], 'focused')
            changed = self.request(); changed['fingerprint'] = 'd'*64
            with self.assertRaises(launchers.LauncherError):
                manager.dispatch(changed, None)
        spawn.assert_not_called()

    @patch.object(launchers, 'check_directory', return_value=(1, 2))
    def test_dead_or_replaced_window_is_interrupted_without_cross_window_cleanup(self, _):
        manager = self.manager()
        manager._read.return_value = {'fingerprint': 'b'*64, 'app': 'terminal', 'window': {'windowId': '12', 'pid': 1, 'start': '10'}}
        manager._window = Mock(return_value=None)
        with patch.object(launchers.os, 'killpg') as kill:
            self.assertEqual(manager.dispatch(self.request(), None)['status'], 'interrupted')
        kill.assert_not_called()
        manager._activate.assert_not_called()

    @patch.object(launchers, 'check_directory', return_value=(1, 2))
    def test_missing_app_is_honest(self, _):
        manager = self.manager()
        with patch.object(launchers.Path, 'iterdir', return_value=iter([])), patch.object(launchers.os, 'access', return_value=False), patch.object(launchers.subprocess, 'Popen') as spawn:
            self.assertEqual(manager.dispatch(self.request(), None)['status'], 'app-missing')
        spawn.assert_not_called()

    def test_cancelled_operation_never_launches_or_kills_another_process(self):
        manager = self.manager(); manager.cancelled = lambda _: True
        with patch.object(launchers.subprocess, 'Popen') as spawn, patch.object(launchers.os, 'killpg') as kill:
            self.assertEqual(manager.dispatch(self.request(), None)['status'], 'interrupted')
        spawn.assert_not_called(); kill.assert_not_called()

class StartupTests(unittest.TestCase):
    request = LauncherTests.request
    manager = LauncherTests.manager
    @patch.object(launchers, 'check_directory', return_value=(1, 2))
    def test_fixed_spawn_is_guest_only_and_waits_for_window(self, _):
        manager = self.manager()
        window = {'windowId': '31', 'pid': 51, 'start': '9'}
        manager._windows.side_effect = [[], [window]]
        manager._start = Mock(return_value='9')
        proc = Mock(pid=51); proc.poll.return_value = None
        with patch.object(launchers.Path, 'iterdir', return_value=iter([])), patch.object(launchers.os, 'access', return_value=True), patch.object(launchers.subprocess, 'Popen', return_value=proc) as spawn:
            result = manager.dispatch(self.request(), None)
        self.assertEqual(result['status'], 'opened')
        self.assertEqual(result['windowId'], '31')
        args, kwargs = spawn.call_args
        self.assertEqual(args[0], launchers.launch_vector('terminal'))
        self.assertIs(kwargs['shell'], False)
        self.assertEqual(kwargs['cwd'], '/home/rerun/workspace')
        self.assertNotIn('TOKEN', kwargs['env'])
        self.assertNotIn('/Users', str(args))

    @patch.object(launchers, 'check_directory', return_value=(1, 2))
    def test_timeout_closes_only_its_exact_new_startup_handle(self, _):
        manager = self.manager()
        manager._check = Mock(side_effect=[None, None, launchers.LauncherError('timeout')])
        manager._start = Mock(return_value='9')
        manager._stop_new = Mock()
        proc = Mock(pid=51); proc.poll.return_value = None
        with patch.object(launchers.Path, 'iterdir', return_value=iter([])), patch.object(launchers.os, 'access', return_value=True), patch.object(launchers.subprocess, 'Popen', return_value=proc):
            result = manager.dispatch(self.request(), None)
        self.assertEqual(result['status'], 'timeout')
        manager._stop_new.assert_called_once_with(proc, '9')

    def test_guest_workspace_symlink_or_missing_directory_refuses(self):
        with patch.object(launchers.Path, 'lstat', side_effect=FileNotFoundError):
            with self.assertRaises(FileNotFoundError):
                launchers.check_directory('/home/rerun/workspace')


class ForegroundTests(unittest.TestCase):
    def manager(self):
        return launchers.GuestComputerLaunchers('c'*64, lambda: {'DISPLAY': ':1', 'HOME': '/home/rerun'}, lambda _: False)

    def test_foreground_requires_exact_live_process_and_class_not_just_a_window_name(self):
        manager = self.manager()
        manager._query = Mock(return_value=(0, '123\n'))
        manager._window = Mock(side_effect=lambda window, app, client, deadline: {'windowId': window, 'pid': 42, 'start': '1234'} if app == 'terminal' else None)
        self.assertEqual(manager.foreground(None), {'app': 'terminal', 'windowId': '123'})
        manager._window = Mock(return_value=None)
        self.assertEqual(manager.foreground(None), {'app': 'unknown', 'windowId': None})
        manager._query = Mock(return_value=(0, 'not-a-window'))
        self.assertEqual(manager.foreground(None), {'app': 'unknown', 'windowId': None})

    def test_browser_focus_reuses_last_verified_window_and_never_spawns(self):
        manager = self.manager()
        windows = [{'windowId': '12', 'pid': 42, 'start': '11'}, {'windowId': '34', 'pid': 43, 'start': '12'}]
        manager._windows = Mock(return_value=windows)
        manager._activate = Mock()
        with patch.object(launchers.subprocess, 'Popen') as spawn:
            manager.focus_browser(None)
            spawn.assert_not_called()
        manager._activate.assert_called_once_with(windows[-1], 'browser', None, unittest.mock.ANY)
        manager._windows.return_value = []
        with self.assertRaises(launchers.LauncherError):
            manager.focus_browser(None)

    def test_capabilities_require_actual_guest_binaries_and_window_verification_tools(self):
        manager = self.manager()
        with patch.object(launchers.os.path, 'isfile', return_value=True), patch.object(launchers.os, 'access', side_effect=lambda path, mode: path != '/usr/bin/thunar'):
            self.assertEqual(manager.capabilities(), {'terminal': True, 'files': False})
        with patch.object(launchers.os.path, 'isfile', side_effect=lambda path: path != '/usr/bin/xprop'), patch.object(launchers.os, 'access', return_value=True):
            self.assertEqual(manager.capabilities(), {'terminal': False, 'files': False})


if __name__ == '__main__':
    unittest.main()

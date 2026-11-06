"""Offline dispatch regressions. All guest I/O is mocked; root executes this file."""
import importlib.util
import pathlib
import unittest
from unittest.mock import Mock, patch

spec = importlib.util.spec_from_file_location('guest_launchers_fixture', pathlib.Path(__file__).with_name('guest.py'))
guest = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guest)


class GuestLauncherDispatch(unittest.TestCase):
    def test_model_input_rechecks_exact_foreground_before_any_x11_input(self):
        expected = {'app': 'terminal', 'windowId': '123'}
        manager = Mock()
        manager.foreground.return_value = {'app': 'files', 'windowId': '456'}
        with patch.object(guest, 'launchers', manager), patch.object(guest, 'perform_input') as perform:
            request = {'op': 'input', 'action': 'key', 'keys': ['Return'], 'expectedForeground': expected}
            with self.assertRaises(guest.GuestError):
                guest.dispatch(request, None)
            perform.assert_not_called()
            manager.foreground.return_value = expected
            self.assertEqual(guest.dispatch(request, None), ({'ok': True}, b''))
            perform.assert_called_once_with(request, None)

    def test_missing_or_unknown_foreground_never_admits_input(self):
        with patch.object(guest, 'launchers', Mock()), patch.object(guest, 'perform_input') as perform:
            for expected in (None, {'app': 'unknown', 'windowId': '123'}, {'app': 'terminal', 'windowId': '123', 'trusted': True}):
                with self.assertRaises(guest.GuestError):
                    guest.dispatch({'op': 'input', 'action': 'type', 'text': 'fixture', 'expectedForeground': expected}, None)
            perform.assert_not_called()

    def test_ping_reports_actual_helper_capabilities_and_old_guest_has_no_launcher_claim(self):
        manager = Mock()
        manager.capabilities.return_value = {'terminal': True, 'files': False}
        with patch.object(guest, 'geometry', return_value=(1280, 720)), patch.object(guest, 'launchers', manager):
            self.assertEqual(guest.dispatch({'op': 'ping'}, None)[0]['launchers'], {'terminal': True, 'files': False})
        with patch.object(guest, 'geometry', return_value=(1280, 720)), patch.object(guest, 'launchers', None):
            self.assertEqual(guest.dispatch({'op': 'ping'}, None)[0]['launchers'], {'terminal': False, 'files': False})


if __name__ == '__main__':
    unittest.main()

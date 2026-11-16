"""Offline regressions for the read-only press probe. The browser is mocked; no page is opened."""
import importlib.util
import pathlib
import unittest
from unittest.mock import Mock, patch

spec = importlib.util.spec_from_file_location('guest_probe_fixture', pathlib.Path(__file__).with_name('guest.py'))
guest = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guest)

GOOD = {'readable': True, 'page': True, 'role': 'button', 'label': 'Pay now', 'host': 'Checkout.Example.com', 'submits': True, 'form': '', 'field': '', 'fieldLabel': ''}


class GuestProbe(unittest.TestCase):
    def test_page_values_are_typed_and_bounded(self):
        cleaned = guest.clean_probe({**GOOD, 'label': 'Pay\n now' + 'x' * 400, 'role': 'admin', 'field': 7, 'extra': 'ignored', 'submits': 'yes'})
        self.assertEqual(cleaned['host'], 'checkout.example.com')
        self.assertEqual(cleaned['role'], 'other')
        self.assertEqual(cleaned['field'], '')
        self.assertFalse(cleaned['submits'])
        self.assertEqual(len(cleaned['label']), 160)
        self.assertTrue(cleaned['label'].startswith('Pay now'))
        self.assertNotIn('extra', cleaned)

    def test_a_host_that_is_not_a_host_is_dropped(self):
        self.assertEqual(guest.clean_probe({**GOOD, 'host': 'bank.example.com/ <b>'})['host'], '')

    def test_a_value_that_is_not_a_record_reads_as_unreadable(self):
        self.assertEqual(guest.clean_probe('Pay now')['readable'], False)
        self.assertEqual(guest.clean_probe(None)['page'], True)

    def test_probe_must_name_what_to_read(self):
        with self.assertRaises(guest.GuestError):
            guest.dispatch({'op': 'probe'}, None)

    def test_only_the_visible_tab_is_read(self):
        answers = iter(['hidden', 'visible', GOOD])
        with patch.object(guest, 'visible_page_sockets', return_value=['ws://a', 'ws://b']), \
                patch.object(guest, 'open_page_socket', return_value=Mock()), \
                patch.object(guest, 'evaluate', side_effect=lambda cdp, expression: next(answers)):
            reply, binary = guest.dispatch({'op': 'probe', 'hover': True}, None)
        self.assertEqual(binary, b'')
        self.assertEqual(reply['label'], 'Pay now')
        self.assertTrue(reply['ok'])

    def test_no_visible_tab_reads_as_unreadable(self):
        with patch.object(guest, 'visible_page_sockets', return_value=['ws://a']), \
                patch.object(guest, 'open_page_socket', return_value=Mock()), \
                patch.object(guest, 'evaluate', return_value='hidden'):
            reply, _ = guest.dispatch({'op': 'probe', 'focused': True}, None)
        self.assertEqual((reply['readable'], reply['page']), (False, True))

    def test_the_probe_script_never_writes_to_the_page(self):
        for banned in ('.click(', '.submit(', '.focus(', 'dispatchEvent', '.value =', 'innerHTML =', 'fetch(', 'XMLHttpRequest'):
            self.assertNotIn(banned, guest.PROBE_JS)


if __name__ == '__main__':
    unittest.main()

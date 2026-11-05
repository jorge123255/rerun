"""Authored pure guest regressions; root runs them without starting the guest."""
import base64
import importlib.util
import pathlib
import socket
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('guest', pathlib.Path(__file__).with_name('guest.py'))
guest = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guest)


class GuestExports(unittest.TestCase):
    def test_original_options_are_bounded_and_do_not_accept_paths_or_truthy_flags(self):
        self.assertEqual(guest.navigation_options({}), 30_000)
        self.assertEqual(guest.navigation_options({'timeoutMs': 120_000, 'links': True}), 120_000)
        for value in (False, True, 0, -1, 120_001, 1.5):
            with self.assertRaises(guest.GuestError):
                guest.navigation_options({'timeoutMs': value})
        for request in ({'links': 'yes'}, {'screenshot': '/Users/fixture.png'}, {'screenshot': True}):
            with self.assertRaises(guest.GuestError):
                guest.navigation_options(request)

    def test_inspects_dimensions_before_capture_and_rejects_pixel_budget(self):
        self.assertEqual(guest.export_dimensions({'width': 10.1, 'height': 20.2}), (11, 21))
        for size in ({'width': 8193, 'height': 1}, {'width': 8192, 'height': 8192}, {'width': 0, 'height': 2}, {'width': True, 'height': 2}, {'width': float('nan'), 'height': 2}):
            with self.assertRaises(guest.GuestError):
                guest.export_dimensions(size)

    def test_whole_html_is_not_silently_truncated_and_utf8_limit_is_bytes(self):
        for value in (None, '', '\x00', '界' * guest.EXPORT_HTML_MAX):
            with patch.object(guest, 'evaluate', return_value=value):
                with self.assertRaises(guest.GuestError):
                    guest.rendered_html(None)
        html = '<!doctype html><p>界</p>'
        with patch.object(guest, 'evaluate', return_value=html):
            self.assertEqual(guest.rendered_html(None), html.encode())

    def test_fragmented_websocket_messages_obey_total_budget(self):
        left, right = socket.socketpair()
        try:
            right.sendall(b'\x01\x04aaaa\x80\x04bbbb')
            with self.assertRaises(guest.GuestError):
                guest.ws_recv(left, limit=6)
        finally:
            left.close(); right.close()

    def test_cancellation_is_checked_during_partial_frame_reads(self):
        left, right = socket.socketpair()
        try:
            with patch.object(guest, 'cancelled', return_value=True):
                with self.assertRaises(guest.GuestError):
                    guest.read_exact(left, 2, guest.time.monotonic() + 1, object())
        finally:
            left.close(); right.close()

    def test_no_full_page_claim_for_dimension_change_or_mismatched_png(self):
        class Cdp:
            deadline = float('inf')
            def __init__(self, after):
                self.after = after
                self.metrics = 0
            def call(self, method, _params, _timeout):
                if method == 'Page.getLayoutMetrics':
                    self.metrics += 1
                    return {'cssContentSize': {'width': 2, 'height': 3 if self.metrics == 1 else self.after}}
                png = b'\x89PNG\r\n\x1a\n' + b'\x00' * 8 + (2).to_bytes(4, 'big') + (3).to_bytes(4, 'big') + b'\x00' * 9
                return {'data': base64.b64encode(png).decode()}
        with self.assertRaises(guest.GuestError):
            guest.full_page_png(Cdp(4))
        cdp = Cdp(3)
        png, width, height = guest.full_page_png(cdp)
        self.assertEqual((width, height), (2, 3))
        self.assertEqual(png[:8], b'\x89PNG\r\n\x1a\n')


if __name__ == '__main__':
    unittest.main()

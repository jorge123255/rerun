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
        base = {'pageOptionsVersion': 1}
        self.assertEqual(guest.navigation_options(base), 30_000)
        self.assertEqual(guest.navigation_options({**base, 'timeoutMs': 120_000, 'links': True}), 120_000)
        for value in (False, True, 0, -1, 120_001, 1.5):
            with self.assertRaises(guest.GuestError):
                guest.navigation_options({**base, 'timeoutMs': value})
        for request in ({'links': 'yes'}, {'screenshot': '/Users/fixture.png'}, {'screenshot': True}, {'hostPath': '/tmp/forbidden'}, {'pageOptionsVersion': 1.0}):
            with self.assertRaises(guest.GuestError):
                guest.navigation_options({**base, **request})
        with self.assertRaises(guest.GuestError):
            guest.navigation_options({})

    def test_main_document_status_ignores_iframes_and_keeps_final_redirect_response(self):
        events = [
            {'method': 'Network.responseReceived', 'params': {'type': 'Document', 'frameId': 'main', 'response': {'status': 302}}},
            {'method': 'Network.responseReceived', 'params': {'type': 'Document', 'frameId': 'main', 'response': {'status': 200}}},
            {'method': 'Network.responseReceived', 'params': {'type': 'Document', 'frameId': 'iframe', 'response': {'status': 500}}},
        ]
        self.assertEqual(guest.main_document_status(events, 'main'), 200)
        self.assertEqual(guest.main_document_status(events, 'unknown'), 0)

    def test_render_settling_and_partial_reads_obey_complete_deadline(self):
        class Clock:
            at = 0
            def monotonic(self):
                self.at += 0.2
                return self.at
        class Cdp:
            deadline = 1
            inflight = {'pending-resource'}
            last_network = 0
        clock = Clock()
        with patch.object(guest.time, 'monotonic', side_effect=clock.monotonic), patch.object(guest, 'evaluate', return_value='loading'), patch.object(guest, 'pause_until', return_value=None):
            guest.settle_render(Cdp())
        self.assertGreaterEqual(clock.at, 1)
        left, right = socket.socketpair()
        try:
            with self.assertRaises(guest.GuestError):
                guest.read_exact(left, 1, guest.time.monotonic() - 1)
        finally:
            left.close(); right.close()

    def test_event_retention_drops_headers_and_bounds_resource_tracking(self):
        cdp = guest.Cdp(None)
        for _ in range(300):
            cdp.remember({'method': 'Network.responseReceived', 'params': {'type': 'Document', 'frameId': 'main', 'response': {'status': 200, 'headers': {'Cookie': 'fixture-secret'}}}})
        self.assertEqual(len(cdp.events), 256)
        self.assertNotIn('fixture-secret', str(cdp.events))
        for index in range(512):
            cdp.remember({'method': 'Network.requestWillBeSent', 'params': {'requestId': str(index)}})
        with self.assertRaises(guest.GuestError):
            cdp.remember({'method': 'Network.requestWillBeSent', 'params': {'requestId': 'overflow'}})

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

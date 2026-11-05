#!/usr/bin/env python3
"""In-guest screen: Xvfb, Openbox, Chromium, and two VNC servers.

The watch server is x11vnc -viewonly. Pointer and key events are dropped by
that process. A browser viewer that merely hides its buttons is not the control.
The drive server is a different port and is not published outside the container.
"""

import base64
import http.client
import json
import os
import re
import select
import shutil
import signal
import socket
import subprocess
import sys
import threading
import time

DISPLAY = ':1'
SCREEN = '1920x1080x24'
DRIVE_PORT = 5900
WATCH_PORT = 5901
CDP_PORT = 9222
RPC_SOCKET = '/run/rerun/rpc.sock'
PROFILE = '/var/lib/rerun/profile'
JSON_MAX = 1_000_000
BINARY_MAX = 8 * 1024 * 1024
TEXT_MAX = 50_000
HTML_MAX = 100_000
LINKS_MAX = 300
LINK_TEXT_MAX = 80
URL_MAX = 2048
TYPE_MAX = 8_000
KEY_MAX = 200
TYPE_DELAY_MS = '12'
DOUBLE_CLICK_DELAY_MS = '80'
WALL_TEXT_MAX = 3_000
CHALLENGE_MAX_S = 15

# Same markers as apps/engine/src/tools/bot-wall.ts. A long page is not a wall.
WALLS = (
    ('Cloudflare', True, re.compile(r'<title>\s*just a moment\.\.\.|cf-chl-|checking your browser before|verify(ing)? you are human|additional verification required', re.I)),
    ('DataDome', True, re.compile(r'captcha-delivery\.com', re.I)),
    ('PerimeterX', True, re.compile(r'px-captcha', re.I)),
    ('Imperva', True, re.compile(r'pardon our interruption|_incapsula_resource', re.I)),
    ('Reddit', False, re.compile(r'blocked by network security|whoa there, pardner|prove your humanity', re.I)),
    ('Google', False, re.compile(r'/sorry/index|our systems have detected unusual traffic', re.I)),
    ('Amazon', False, re.compile(r'enter the characters you see below', re.I)),
)
# Same consent selectors as apps/engine/src/tools/builtin/browser.ts.
CONSENT_JS = r"""
(() => {
  const selectors = ['#L2AGLb','form[action^="https://consent."] button[aria-label^="Accept"]','#onetrust-accept-btn-handler','#didomi-notice-agree-button','#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll','#axeptio_btn_acceptAll','.qc-cmp2-summary-buttons button[mode="primary"]'];
  const name = /^(accept all|accept|allow all|i agree|agree|tout accepter|accepter|alle akzeptieren|aceptar todo)$/i;
  for (const selector of selectors) {
    const node = document.querySelector(selector);
    if (node && node.offsetParent !== null) { node.click(); return true; }
  }
  for (const button of document.querySelectorAll('button')) {
    if (name.test((button.innerText || '').trim()) && button.offsetParent !== null) { button.click(); return true; }
  }
  return false;
})()
"""
LINKS_JS = r"""
(() => {
  const seen = new Set();
  const links = [];
  for (const anchor of document.querySelectorAll('a[href]')) {
    const href = anchor.href || '';
    if (!/^https?:\/\//.test(href) || seen.has(href)) continue;
    seen.add(href);
    links.push({ href, text: (anchor.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 80) });
    if (links.length === 300) break;
  }
  return links;
})()
"""
KEY_COMBO = re.compile(r'^[A-Za-z0-9_]+(\+[A-Za-z0-9_]+)*$')
KEY_ALIASES = {
    'enter': 'Return', 'return': 'Return', 'esc': 'Escape', 'escape': 'Escape',
    'backspace': 'BackSpace', 'delete': 'Delete', 'del': 'Delete', 'tab': 'Tab',
    'space': 'space', 'up': 'Up', 'down': 'Down', 'left': 'Left', 'right': 'Right',
    'arrowup': 'Up', 'arrowdown': 'Down', 'arrowleft': 'Left', 'arrowright': 'Right',
    'pageup': 'Page_Up', 'page_up': 'Page_Up', 'pagedown': 'Page_Down', 'page_down': 'Page_Down',
    'home': 'Home', 'end': 'End', 'insert': 'Insert', 'ctrl': 'ctrl', 'control': 'ctrl',
    'alt': 'alt', 'option': 'alt', 'shift': 'shift', 'super': 'super', 'cmd': 'super',
    'command': 'super', 'meta': 'super', 'win': 'super',
}
FUNCTION_KEY = re.compile(r'^f\d{1,2}$')
BANNED_MOUNT = ('docker.sock', '/Users/', '/Volumes/', '/private/var', 'Application Support', '.ssh', '.aws', '.gnupg', 'Keychains')
PROFILE_LOCKS = ('SingletonLock', 'SingletonCookie', 'SingletonSocket')
PROFILE_CACHES = (
    'Default/Cache', 'Default/Code Cache', 'Default/GPUCache', 'Default/DawnWebGPUCache',
    'Default/DawnGraphiteCache', 'Default/Service Worker/CacheStorage', 'BrowserMetrics',
)
SCROLL_BUTTONS = {'up': '4', 'down': '5', 'left': '6', 'right': '7'}
CLICK_BUTTONS = {'left': '1', 'right': '3'}

children = []
action_lock = threading.Lock()


class GuestError(Exception):
    def __init__(self, reason, refusal=False):
        super().__init__(reason)
        self.reason = reason
        self.refusal = refusal


def read_exact(source, size):
    chunks = []
    got = 0
    while got < size:
        chunk = source.read(size - got) if hasattr(source, 'read') else source.recv(size - got)
        if not chunk:
            raise GuestError('The screen connection closed.')
        chunks.append(chunk)
        got += len(chunk)
    return b''.join(chunks)


def encode_frame(value, binary=b''):
    body = json.dumps(value, separators=(',', ':')).encode()
    if len(body) > JSON_MAX or len(binary) > BINARY_MAX:
        raise GuestError('The screen response is too large.')
    return len(body).to_bytes(4, 'big') + len(binary).to_bytes(4, 'big') + body + binary


def decode_frame(blob):
    if len(blob) < 8:
        raise GuestError('The screen request was cut off.')
    json_len = int.from_bytes(blob[:4], 'big')
    binary_len = int.from_bytes(blob[4:8], 'big')
    if json_len > JSON_MAX or binary_len > BINARY_MAX or len(blob) != 8 + json_len + binary_len:
        raise GuestError('The screen request is too large.')
    try:
        value = json.loads(blob[8:8 + json_len].decode())
    except json.JSONDecodeError as error:
        raise GuestError('The screen request was not valid.') from error
    return value, blob[8 + json_len:]


def check_mounts():
    profile = False
    with open('/proc/self/mountinfo', encoding='utf-8', errors='replace') as handle:
        for line in handle:
            if any(banned in line for banned in BANNED_MOUNT):
                sys.stderr.write('refusing a host mount\n')
                return 78
            parts = line.split()
            if len(parts) < 10 or '-' not in parts:
                continue
            separator = parts.index('-')
            mount_point = parts[4]
            source = parts[separator + 2] if separator + 2 < len(parts) else ''
            if mount_point == PROFILE:
                profile = True
                if any(banned in source for banned in BANNED_MOUNT):
                    sys.stderr.write('refusing a host profile mount\n')
                    return 78
    if not profile:
        sys.stderr.write('the profile volume is missing\n')
        return 78
    return 0


def guest_env():
    env = {key: os.environ[key] for key in ('PATH', 'LANG', 'LC_ALL', 'HOME') if key in os.environ}
    env.update({
        'PATH': env.get('PATH', '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'),
        'HOME': '/home/rerun',
        'LANG': 'C.UTF-8',
        'LC_ALL': 'C.UTF-8',
        'DISPLAY': DISPLAY,
        'XDG_RUNTIME_DIR': '/run/rerun',
        'GTK_THEME': 'Adwaita:dark',
    })
    return env


def spawn(argv):
    proc = subprocess.Popen(argv, env=guest_env(), stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
    children.append(proc)
    return proc


def stop_children():
    for proc in children:
        if proc.poll() is None:
            try:
                os.killpg(proc.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
    deadline = time.time() + 2
    for proc in children:
        remaining = max(0, deadline - time.time())
        try:
            proc.wait(timeout=remaining)
        except subprocess.TimeoutExpired:
            try:
                os.killpg(proc.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass


def wait_for(predicate, timeout):
    deadline = time.time() + timeout
    while time.time() < deadline:
        if predicate():
            return True
        time.sleep(0.1)
    return False


def display_ready():
    return os.path.exists(f'/tmp/.X11-unix/X{DISPLAY[1:]}')


def port_ready(port):
    try:
        with socket.create_connection(('127.0.0.1', port), 0.2):
            return True
    except OSError:
        return False


def clear_stale_profile():
    for name in PROFILE_LOCKS:
        try:
            os.unlink(os.path.join(PROFILE, name))
        except FileNotFoundError:
            pass
    for relative in PROFILE_CACHES:
        path = os.path.join(PROFILE, relative)
        if os.path.isdir(path):
            subprocess.call(['rm', '-rf', '--', path])


def chromium_bin():
    for name in ('chromium', 'chromium-browser'):
        if shutil.which(name):
            return name
    raise GuestError('Chromium is not installed in the guest.')


def supervise():
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
    signal.signal(signal.SIGINT, lambda *_: sys.exit(0))
    try:
        clear_stale_profile()
        spawn(['Xvfb', DISPLAY, '-screen', '0', SCREEN, '-nolisten', 'tcp'])
        if not wait_for(display_ready, 10):
            raise GuestError('The guest display did not start.')
        spawn(['openbox', '--config-file', '/usr/local/share/rerun/openbox.xml'])
        x11 = ['x11vnc', '-display', DISPLAY, '-localhost', '-forever', '-shared', '-nopw', '-quiet']
        spawn([*x11, '-rfbport', str(DRIVE_PORT)])
        spawn([*x11, '-rfbport', str(WATCH_PORT), '-viewonly'])
        if not wait_for(lambda: port_ready(DRIVE_PORT) and port_ready(WATCH_PORT), 10):
            raise GuestError('The guest VNC servers did not start.')
        spawn([
            chromium_bin(),
            f'--user-data-dir={PROFILE}',
            f'--remote-debugging-port={CDP_PORT}',
            '--remote-debugging-address=127.0.0.1',
            f'--remote-allow-origins=http://127.0.0.1:{CDP_PORT}',
            '--no-first-run',
            '--no-default-browser-check',
            '--disable-sync',
            '--disable-translate',
            '--disable-gpu',
            '--disable-dev-shm-usage',
            # cap-drop ALL removes Chromium's setuid sandbox. The container is the sandbox.
            '--no-sandbox',
            '--start-maximized',
            'about:blank',
        ])
        if not wait_for(lambda: port_ready(CDP_PORT), 20):
            raise GuestError('The guest browser did not start.')
        serve_rpc()
    finally:
        stop_children()


def serve_rpc():
    if os.path.exists(RPC_SOCKET):
        os.unlink(RPC_SOCKET)
    server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    server.bind(RPC_SOCKET)
    os.chmod(RPC_SOCKET, 0o600)
    server.listen(4)
    while True:
        client, _ = server.accept()
        threading.Thread(target=handle_client, args=(client,), daemon=True).start()


def handle_client(client):
    try:
        with action_lock:
            request, _ = read_socket_frame(client)
            if cancelled(client):
                raise GuestError('The screen action was cancelled.', refusal=False)
            payload, binary = dispatch(request, client)
        client.sendall(encode_frame(payload, binary))
    except GuestError as error:
        try:
            client.sendall(encode_frame({'ok': False, 'refusal': error.refusal, 'reason': error.reason}))
        except OSError:
            pass
    except Exception:
        try:
            client.sendall(encode_frame({'ok': False, 'refusal': False, 'reason': 'The screen action failed.'}))
        except OSError:
            pass
    finally:
        client.close()


def read_socket_frame(client):
    header = read_exact(client, 8)
    json_len = int.from_bytes(header[:4], 'big')
    binary_len = int.from_bytes(header[4:8], 'big')
    if json_len > JSON_MAX or binary_len > BINARY_MAX:
        raise GuestError('The screen request is too large.')
    return decode_frame(header + read_exact(client, json_len + binary_len))


def cancelled(client):
    try:
        client.settimeout(0)
        peeked = client.recv(1, socket.MSG_PEEK)
        return peeked == b''
    except BlockingIOError:
        return False
    except OSError:
        return True
    finally:
        client.settimeout(None)


def dispatch(request, client):
    if not isinstance(request, dict):
        raise GuestError('The screen request was not valid.', refusal=True)
    op = request.get('op')
    if op == 'ping':
        width, height = geometry()
        return {'ok': True, 'ready': True, 'width': width, 'height': height}, b''
    if op == 'geometry':
        width, height = geometry()
        return {'ok': True, 'width': width, 'height': height}, b''
    if op == 'screenshot':
        return screenshot()
    if op == 'release':
        run_xdotool(['mouseup', '1', '3'], client)
        return {'ok': True}, b''
    if op == 'location':
        return {'ok': True, 'url': current_url()}, b''
    if op == 'input':
        perform_input(request, client)
        return {'ok': True}, b''
    if op == 'navigate':
        return navigate(request.get('url'), client), b''
    raise GuestError('That screen action is not available.', refusal=True)


def geometry():
    out = subprocess.check_output(['xdotool', 'getdisplaygeometry'], env=guest_env(), timeout=5)
    width, height = out.decode().split()
    return int(width), int(height)


def screenshot():
    proc = subprocess.run(['maim', '--format', 'png'], env=guest_env(), stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=10, check=False)
    if proc.returncode != 0 or not proc.stdout or len(proc.stdout) > BINARY_MAX:
        raise GuestError('The screenshot could not be taken.')
    width, height = geometry()
    return {'ok': True, 'width': width, 'height': height, 'media': 'image/png'}, proc.stdout


def run_xdotool(args, client, stdin=None):
    if cancelled(client):
        raise GuestError('The screen action was cancelled.')
    proc = subprocess.Popen(['xdotool', *args], env=guest_env(), stdin=subprocess.PIPE if stdin is not None else subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
    if stdin is not None and proc.stdin:
        proc.stdin.write(stdin)
        proc.stdin.close()
    while proc.poll() is None:
        if cancelled(client):
            os.killpg(proc.pid, signal.SIGKILL)
            raise GuestError('The screen action was cancelled.')
        time.sleep(0.05)
    if proc.returncode != 0:
        raise GuestError('The screen did not accept that input.')


def perform_input(request, client):
    action = request.get('action')
    if action == 'mousemove':
        run_xdotool(['mousemove', '--sync', *point(request, 'x', 'y')], client)
        return
    if action == 'click':
        button = CLICK_BUTTONS.get(request.get('button'))
        if button is None:
            raise GuestError('That mouse button is not available.', refusal=True)
        run_xdotool(['mousemove', '--sync', *point(request, 'x', 'y')], client)
        args = ['click']
        if request.get('double') is True:
            args += ['--repeat', '2', '--delay', DOUBLE_CLICK_DELAY_MS]
        run_xdotool([*args, button], client)
        return
    if action == 'drag':
        run_xdotool(['mousemove', '--sync', *point(request, 'x1', 'y1')], client)
        try:
            run_xdotool(['mousedown', '1'], client)
            run_xdotool(['mousemove', '--sync', *point(request, 'x2', 'y2')], client)
        finally:
            subprocess.run(['xdotool', 'mouseup', '1'], env=guest_env(), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=5, check=False)
        return
    if action == 'scroll':
        button = SCROLL_BUTTONS.get(request.get('direction'))
        amount = request.get('amount')
        if button is None or not isinstance(amount, int) or isinstance(amount, bool) or not 1 <= amount <= 30:
            raise GuestError('That scroll is not available.', refusal=True)
        run_xdotool(['mousemove', '--sync', *point(request, 'x', 'y')], client)
        run_xdotool(['click', '--repeat', str(amount), button], client)
        return
    if action == 'type':
        text = request.get('text')
        if not isinstance(text, str) or text == '' or len(text) > TYPE_MAX:
            raise GuestError('type needs text.', refusal=True)
        run_xdotool(['type', '--delay', TYPE_DELAY_MS, '--file', '-'], client, stdin=text.encode())
        return
    if action == 'key':
        keys = request.get('keys')
        if not isinstance(keys, str) or len(keys) > KEY_MAX:
            raise GuestError('Name the key to press, for example "Return" or "ctrl+a".', refusal=True)
        for combo in key_combos(keys):
            try:
                run_xdotool(['key', '--', combo], client)
            finally:
                if cancelled(client):
                    subprocess.run(['xdotool', 'keyup', '--', combo], env=guest_env(), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=5, check=False)
        return
    raise GuestError('That screen action is not available.', refusal=True)


def point(request, x_key, y_key):
    width, height = geometry()
    values = []
    for key in (x_key, y_key):
        value = request.get(key)
        if isinstance(value, bool) or not isinstance(value, int):
            raise GuestError('That point is off the screen.', refusal=True)
        limit = width if key.startswith('x') else height
        if value < 0 or value >= limit:
            raise GuestError('That point is off the screen.', refusal=True)
        values.append(str(value))
    return values


def key_name(part):
    lower = part.lower()
    if FUNCTION_KEY.match(lower):
        return lower.upper()
    return KEY_ALIASES.get(lower, part)


def key_combos(keys):
    combos = [combo for combo in keys.strip().split() if combo]
    if not combos:
        raise GuestError('Name the key to press, for example "Return" or "ctrl+a".', refusal=True)
    mapped = []
    for combo in combos:
        if not KEY_COMBO.match(combo):
            raise GuestError(f'"{combo}" is not a key. Name keys like "Return", "Escape", "ctrl+a" or "shift+Tab".', refusal=True)
        mapped.append('+'.join(key_name(part) for part in combo.split('+')))
    return mapped


def http_json(method, path):
    conn = http.client.HTTPConnection('127.0.0.1', CDP_PORT, timeout=5)
    try:
        conn.request(method, path)
        response = conn.getresponse()
        body = response.read(JSON_MAX)
        if response.status >= 400:
            raise GuestError('The guest browser did not answer.')
        return json.loads(body.decode())
    finally:
        conn.close()


def page_socket():
    targets = http_json('GET', '/json/list')
    pages = [item for item in targets if isinstance(item, dict) and item.get('type') == 'page' and item.get('webSocketDebuggerUrl')]
    if not pages:
        created = http_json('PUT', '/json/new?about:blank')
        if not isinstance(created, dict) or 'webSocketDebuggerUrl' not in created:
            created = http_json('GET', '/json/new?about:blank')
        pages = [created]
    url = pages[0].get('webSocketDebuggerUrl')
    if not isinstance(url, str) or not url.startswith(f'ws://127.0.0.1:{CDP_PORT}/'):
        raise GuestError('The guest browser did not answer.')
    path = url.split(f'127.0.0.1:{CDP_PORT}', 1)[1]
    sock = socket.create_connection(('127.0.0.1', CDP_PORT), 5)
    key = base64.b64encode(os.urandom(16)).decode()
    sock.sendall((
        f'GET {path} HTTP/1.1\r\n'
        f'Host: 127.0.0.1:{CDP_PORT}\r\n'
        'Upgrade: websocket\r\n'
        'Connection: Upgrade\r\n'
        f'Sec-WebSocket-Key: {key}\r\n'
        'Sec-WebSocket-Version: 13\r\n\r\n'
    ).encode())
    banner = b''
    while b'\r\n\r\n' not in banner:
        chunk = sock.recv(4096)
        if not chunk:
            raise GuestError('The guest browser did not answer.')
        banner += chunk
        if len(banner) > 8192:
            raise GuestError('The guest browser did not answer.')
    if b' 101 ' not in banner.split(b'\r\n', 1)[0]:
        raise GuestError('The guest browser did not answer.')
    return sock


def ws_send(sock, payload):
    data = json.dumps(payload).encode()
    mask = os.urandom(4)
    header = bytearray([0x81])
    length = len(data)
    if length < 126:
        header.append(0x80 | length)
    elif length < 65536:
        header.append(0x80 | 126)
        header += length.to_bytes(2, 'big')
    else:
        header.append(0x80 | 127)
        header += length.to_bytes(8, 'big')
    masked = bytes(byte ^ mask[index % 4] for index, byte in enumerate(data))
    sock.sendall(bytes(header) + mask + masked)


def ws_recv(sock):
    pieces = []
    while True:
        header = read_exact(sock, 2)
        opcode = header[0] & 0x0F
        masked = header[1] & 0x80
        length = header[1] & 0x7F
        if length == 126:
            length = int.from_bytes(read_exact(sock, 2), 'big')
        elif length == 127:
            length = int.from_bytes(read_exact(sock, 8), 'big')
        if length > JSON_MAX:
            raise GuestError('The guest browser returned too much.')
        mask = read_exact(sock, 4) if masked else b''
        payload = read_exact(sock, length)
        if masked:
            payload = bytes(byte ^ mask[index % 4] for index, byte in enumerate(payload))
        if opcode == 9:
            sock.sendall(bytes([0x8A, len(payload)]) + payload)
            continue
        if opcode == 8:
            raise GuestError('The guest browser closed.')
        if opcode in (0, 1):
            pieces.append(payload)
            if header[0] & 0x80:
                return json.loads(b''.join(pieces).decode())
        elif header[0] & 0x80:
            pieces.clear()


class Cdp:
    def __init__(self, sock):
        self.sock = sock
        self.next_id = 1
        self.events = []

    def call(self, method, params, timeout):
        call_id = self.next_id
        self.next_id += 1
        self.sock.settimeout(timeout)
        ws_send(self.sock, {'id': call_id, 'method': method, 'params': params})
        deadline = time.time() + timeout
        while time.time() < deadline:
            self.sock.settimeout(max(0.1, deadline - time.time()))
            message = ws_recv(self.sock)
            if message.get('id') == call_id:
                if 'error' in message:
                    raise GuestError('The page could not be read.')
                return message.get('result') or {}
            self.events.append(message)
        raise GuestError('The page took too long.')


def evaluate(cdp, expression):
    result = cdp.call('Runtime.evaluate', {'expression': expression, 'returnByValue': True}, 10)
    return (result.get('result') or {}).get('value')


def detect_wall(html, text):
    if not isinstance(text, str) or len(text) > WALL_TEXT_MAX:
        return None
    sample = html if isinstance(html, str) else ''
    for provider, clears, marker in WALLS:
        if marker.search(sample) or marker.search(text):
            return {'provider': provider, 'clearsByItself': clears}
    return None


def http_url(value):
    if not isinstance(value, str) or not value or len(value) > URL_MAX or any(ord(char) < 32 for char in value):
        raise GuestError('Open an http or https page.', refusal=True)
    match = re.match(r'^(https?)://([^/@\s]+)(/.*)?$', value, re.I)
    if not match or match.group(2).startswith('.') or '..' in match.group(2):
        raise GuestError('Open an http or https page.', refusal=True)
    return value


def navigate(url, client):
    target = http_url(url)
    sock = page_socket()
    try:
        cdp = Cdp(sock)
        cdp.call('Page.enable', {}, 5)
        cdp.call('Network.enable', {}, 5)
        cdp.call('Page.navigate', {'url': target}, 10)
        deadline = time.time() + 30
        while time.time() < deadline:
            if cancelled(client):
                raise GuestError('The screen action was cancelled.')
            if any(event.get('method') == 'Page.loadEventFired' for event in cdp.events):
                break
            cdp.sock.settimeout(1)
            try:
                message = ws_recv(cdp.sock)
            except socket.timeout:
                continue
            if 'method' in message:
                cdp.events.append(message)
        else:
            raise GuestError('The page took too long.')
        for _ in range(CHALLENGE_MAX_S):
            html = evaluate(cdp, f'(document.documentElement && document.documentElement.outerHTML || "").slice(0, {HTML_MAX})')
            text = evaluate(cdp, 'document.body ? document.body.innerText : ""')
            wall = detect_wall(html if isinstance(html, str) else '', text if isinstance(text, str) else '')
            if not wall or wall['clearsByItself'] is False:
                break
            if cancelled(client):
                raise GuestError('The screen action was cancelled.')
            time.sleep(1)
        clicked = evaluate(cdp, CONSENT_JS)
        if clicked is True:
            time.sleep(1)
        html = evaluate(cdp, f'(document.documentElement && document.documentElement.outerHTML || "").slice(0, {HTML_MAX})')
        text = evaluate(cdp, 'document.body ? document.body.innerText : ""')
        links = evaluate(cdp, LINKS_JS)
        final = evaluate(cdp, 'location.href')
    finally:
        sock.close()
    text = text if isinstance(text, str) else ''
    html = html if isinstance(html, str) else ''
    status = 0
    for event in cdp.events:
        params = event.get('params') or {}
        response = params.get('response') or {}
        if event.get('method') == 'Network.responseReceived' and params.get('type') == 'Document':
            status = int(response.get('status') or 0)
    safe_links = []
    if isinstance(links, list):
        for link in links:
            if not isinstance(link, dict):
                continue
            href = link.get('href')
            if not isinstance(href, str) or not href.startswith(('http://', 'https://')):
                continue
            label = link.get('text') if isinstance(link.get('text'), str) else ''
            safe_links.append({'href': href, 'text': label[:LINK_TEXT_MAX]})
            if len(safe_links) == LINKS_MAX:
                break
    truncated = len(text) > TEXT_MAX
    return {
        'ok': True,
        'status': status,
        'finalUrl': final if isinstance(final, str) and final.startswith(('http://', 'https://')) else target,
        'text': text[:TEXT_MAX],
        'html': html[:HTML_MAX],
        'truncated': truncated,
        'links': safe_links,
    }


def current_url():
    sock = page_socket()
    try:
        cdp = Cdp(sock)
        value = evaluate(cdp, 'location.href')
    except GuestError:
        return None
    finally:
        sock.close()
    if isinstance(value, str) and value.startswith(('http://', 'https://')) and value != 'about:blank':
        return value
    return None


def bridge_stdio(port):
    remote = socket.create_connection(('127.0.0.1', port), 5)
    streams = [sys.stdin.buffer, remote]
    try:
        while True:
            readable, _, _ = select.select(streams, [], [], 30)
            if not readable:
                continue
            for stream in readable:
                if stream is sys.stdin.buffer:
                    chunk = os.read(sys.stdin.fileno(), 65536)
                    if not chunk:
                        return
                    remote.sendall(chunk)
                else:
                    chunk = remote.recv(65536)
                    if not chunk:
                        return
                    sys.stdout.buffer.write(chunk)
                    sys.stdout.buffer.flush()
    finally:
        remote.close()


def rpc_main():
    blob = sys.stdin.buffer.read(8 + JSON_MAX + BINARY_MAX + 1)
    request, _ = decode_frame(blob)
    client = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    client.connect(RPC_SOCKET)
    client.sendall(encode_frame(request))
    header = read_exact(client, 8)
    json_len = int.from_bytes(header[:4], 'big')
    binary_len = int.from_bytes(header[4:8], 'big')
    if json_len > JSON_MAX or binary_len > BINARY_MAX:
        raise GuestError('The screen response is too large.')
    sys.stdout.buffer.write(header + read_exact(client, json_len + binary_len))
    sys.stdout.buffer.flush()


def main():
    mode = sys.argv[1] if len(sys.argv) > 1 else ''
    if mode == 'check-mounts':
        sys.exit(check_mounts())
    if mode == 'supervise':
        try:
            supervise()
        except GuestError as error:
            sys.stderr.write(error.reason + '\n')
            sys.exit(1)
    if mode == 'rpc':
        try:
            rpc_main()
        except GuestError as error:
            sys.stdout.buffer.write(encode_frame({'ok': False, 'refusal': error.refusal, 'reason': error.reason}))
            sys.exit(0)
    if mode == 'vnc':
        which = sys.argv[2] if len(sys.argv) == 3 else ''
        if which == 'watch':
            bridge_stdio(WATCH_PORT)
            return
        if which == 'drive':
            bridge_stdio(DRIVE_PORT)
            return
        sys.stderr.write('choose watch or drive\n')
        sys.exit(2)
    sys.stderr.write('unknown guest command\n')
    sys.exit(2)


if __name__ == '__main__':
    main()

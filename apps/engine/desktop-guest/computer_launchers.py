"""Fixed launchers for the existing guest supervisor; importing performs no I/O."""
import json
import itertools
import os
import re
import signal
import selectors
import stat
import subprocess
import threading
import time
from pathlib import Path

WORKSPACE = '/home/rerun/workspace'
JOURNAL = '/run/rerun/computer-launchers'
APPS = {'terminal': ('/usr/bin/xfce4-terminal', 'Xfce4-terminal'),
        'files': ('/usr/bin/thunar', 'Thunar')}
MAX_ATTEMPTS = 256
READY_SECONDS = 8.0
QUERY_SECONDS = 1.0
MAX_OUTPUT = 16384
IDENTITY = re.compile(r'^[a-f0-9]{64}$')


class LauncherError(Exception):
    def __init__(self, state):
        super().__init__(state)
        self.state = state


def parse_request(request):
    # requestId is the existing guest transport cancellation identity, not launch identity.
    keys = {'op', 'operationId', 'fingerprint', 'app', 'mode'}
    if not isinstance(request, dict) or set(request) - (keys | {'requestId'}) or not keys.issubset(request):
        raise LauncherError('refused')
    if request['op'] != 'computer-launcher' or not isinstance(request['app'], str) or request['app'] not in APPS or not isinstance(request['mode'], str) or request['mode'] not in ('launch', 'reconcile', 'verify'):
        raise LauncherError('refused')
    if any(not isinstance(request[key], str) or not IDENTITY.fullmatch(request[key]) for key in ('operationId', 'fingerprint')):
        raise LauncherError('refused')
    return {key: request[key] for key in keys}


def launch_vector(app):
    if app == 'files':
        return ['/usr/bin/thunar', WORKSPACE]
    if app == 'terminal':
        return ['/usr/bin/xfce4-terminal', '--working-directory=' + WORKSPACE]
    raise LauncherError('refused')


def check_directory(path):
    current = Path('/')
    for part in Path(path).parts[1:]:
        current /= part
        info = current.lstat()
        if not stat.S_ISDIR(info.st_mode) or stat.S_ISLNK(info.st_mode):
            raise LauncherError('runtime-unavailable')
    info = os.stat(path)
    if info.st_uid != os.getuid() or os.path.realpath(path) != path:
        raise LauncherError('runtime-unavailable')
    return (info.st_dev, info.st_ino)


class GuestComputerLaunchers:
    def __init__(self, guest_identity, guest_env, cancelled, track_child=None):
        if not isinstance(guest_identity, str) or not IDENTITY.fullmatch(guest_identity):
            raise LauncherError('runtime-unavailable')
        self.identity = guest_identity  # trusted supervisor/container generation, never request text
        self.guest_env = guest_env
        self.cancelled = cancelled
        self.track_child = track_child or (lambda proc: None)
        self.lock = threading.Lock()
        self.children = []

    def _check(self, client, deadline):
        if self.cancelled(client):
            raise LauncherError('interrupted')
        if time.monotonic() >= deadline:
            raise LauncherError('timeout')

    def _environment(self):
        source = self.guest_env()
        if source.get('DISPLAY') != ':1' or source.get('HOME') != '/home/rerun':
            raise LauncherError('runtime-unavailable')
        allowed = ('DISPLAY', 'HOME', 'LANG', 'LC_ALL', 'GTK_THEME', 'XDG_RUNTIME_DIR')
        return {**{key: source[key] for key in allowed if key in source}, 'PATH': '/usr/bin:/bin'}

    def _query(self, args, client, deadline):
        self._check(client, deadline)
        proc = subprocess.Popen(args, env=self._environment(), stdin=subprocess.DEVNULL,
                                stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, shell=False, start_new_session=True)
        until = min(deadline, time.monotonic() + QUERY_SECONDS)
        output = bytearray()
        selector = selectors.DefaultSelector()
        selector.register(proc.stdout, selectors.EVENT_READ)
        try:
            while selector.get_map():
                self._check(client, until)
                for key, _ in selector.select(0.02):
                    chunk = os.read(key.fileobj.fileno(), 4096)
                    if not chunk:
                        selector.unregister(key.fileobj)
                        continue
                    output.extend(chunk)
                    if len(output) > MAX_OUTPUT:
                        raise LauncherError('refused')
            while proc.poll() is None:
                self._check(client, until)
                time.sleep(0.02)
            return proc.returncode, output.decode('utf-8', errors='strict')
        finally:
            selector.close()
            if proc.poll() is None:
                os.killpg(proc.pid, signal.SIGKILL)
            proc.wait(timeout=1)
            proc.stdout.close()

    def _process(self, pid, app):
        try:
            path = Path('/proc') / str(pid)
            info = path.stat()
            if info.st_uid != os.getuid():
                return None
            executable = os.path.realpath(path / 'exe')
            if executable != APPS[app][0]:
                return None
            with open(path / 'environ', 'rb') as handle:
                env = handle.read(16385)
            if len(env) > 16384 or b'DISPLAY=:1' not in env.split(b'\0'):
                return None
            return self._start(pid)
        except (OSError, IndexError):
            return None

    @staticmethod
    def _start(pid):
        try:
            with open('/proc/' + str(pid) + '/stat', encoding='utf-8') as handle:
                raw = handle.read(4096)
            return raw.rsplit(')', 1)[1].split()[19]
        except (OSError, IndexError):
            return None

    def _window(self, window, app, client, deadline):
        if not isinstance(window, str) or not re.fullmatch(r'[1-9][0-9]{0,15}', window):
            return None
        code, text = self._query(['/usr/bin/xprop', '-id', window, '_NET_WM_PID', 'WM_CLASS'], client, deadline)
        pid_match = re.search(r'_NET_WM_PID\(CARDINAL\)\s*=\s*(\d+)', text)
        classes = re.findall(r'"([^"\n]*)"', text)
        if code or not pid_match or APPS[app][1] not in classes:
            return None
        pid = int(pid_match[1])
        start = self._process(pid, app)
        return {'windowId': window, 'pid': pid, 'start': start} if start else None

    def _windows(self, app, client, deadline):
        code, text = self._query(['/usr/bin/xdotool', 'search', '--onlyvisible', '--class', '^' + APPS[app][1] + '$'], client, deadline)
        if code not in (0, 1):
            raise LauncherError('runtime-unavailable')
        ids = text.split()
        if len(ids) > 64:
            raise LauncherError('busy')
        windows = [self._window(window, app, client, deadline) for window in ids]
        return [window for window in windows if window]

    def _path(self, operation_id):
        check_directory(JOURNAL)
        return Path(JOURNAL) / (operation_id + '.json')

    def _read(self, operation_id):
        path = self._path(operation_id)
        try:
            fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        except FileNotFoundError:
            return None
        with os.fdopen(fd, 'rb') as handle:
            info = os.fstat(handle.fileno())
            if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_nlink != 1 or info.st_size > 4096:
                raise LauncherError('interrupted')
            record = json.loads(handle.read(4097))
        if not isinstance(record, dict) or record.get('identity') != self.identity:
            raise LauncherError('interrupted')
        return record

    def _write(self, operation_id, record):
        path = self._path(operation_id)
        raw = json.dumps(record, sort_keys=True).encode('utf-8')
        if len(raw) > 4096:
            raise LauncherError('refused')
        temp = str(path) + '.pending'
        fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        try:
            with os.fdopen(fd, 'wb') as handle:
                handle.write(raw)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temp, path)
            directory = os.open(JOURNAL, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
            try:
                os.fsync(directory)
            finally:
                os.close(directory)
        finally:
            try:
                os.unlink(temp)
            except FileNotFoundError:
                pass

    def _activate(self, window, app, client, deadline):
        current = self._window(window['windowId'], app, client, deadline)
        if current != window:
            raise LauncherError('interrupted')
        code, _ = self._query(['/usr/bin/xdotool', 'windowactivate', '--sync', window['windowId']], client, deadline)
        if code:
            raise LauncherError('interrupted')
        code, focused = self._query(['/usr/bin/xdotool', 'getactivewindow'], client, deadline)
        if code or focused.strip() != window['windowId']:
            raise LauncherError('interrupted')
        # Match the original app-open repaint behavior without accepting an old browser image.
        self._check(client, deadline)
        time.sleep(2.0)
        self._check(client, deadline)

    def _stop_new(self, proc, start):
        if proc is None or proc.poll() is not None or not start:
            return
        # Only this exact startup process/session; never an existing window's process.
        try:
            with open('/proc/' + str(proc.pid) + '/stat', encoding='utf-8') as handle:
                current = handle.read(4096).rsplit(')', 1)[1].split()[19]
            if current != start or os.getpgid(proc.pid) != proc.pid:
                return
            os.killpg(proc.pid, signal.SIGTERM)
            try:
                proc.wait(timeout=0.5)
            except subprocess.TimeoutExpired:
                os.killpg(proc.pid, signal.SIGKILL)
                proc.wait(timeout=1)
        except (ProcessLookupError, FileNotFoundError):
            pass

    def dispatch(self, request, client):
        request = parse_request(request)
        if not self.lock.acquire(blocking=False):
            raise LauncherError('busy')
        proc, start, visible = None, None, False
        deadline = time.monotonic() + READY_SECONDS
        try:
            self._check(client, deadline)
            workspace_identity = check_directory(WORKSPACE)
            record = self._read(request['operationId'])
            if record is not None:
                if record.get('fingerprint') != request['fingerprint'] or record.get('app') != request['app']:
                    raise LauncherError('refused')
                window = record.get('window')
                if not window or self._window(window['windowId'], request['app'], client, deadline) != window:
                    return self._reply(request, 'interrupted', None)
                if request['mode']=='verify':
                    code, focused=self._query(['/usr/bin/xdotool','getactivewindow'],client,deadline)
                    if code or focused.strip()!=window['windowId']:
                        return self._reply(request,'interrupted',None)
                else:
                    self._activate(window, request['app'], client, deadline)
                return self._reply(request, 'focused', window['windowId'])
            if request['mode'] in ('reconcile','verify'):
                return self._reply(request, 'interrupted', None)
            if len(list(itertools.islice(Path(JOURNAL).iterdir(), MAX_ATTEMPTS))) >= MAX_ATTEMPTS:
                raise LauncherError('busy')
            record = {'identity': self.identity, 'fingerprint': request['fingerprint'], 'app': request['app'], 'window': None, 'phase': 'reserved'}
            self._write(request['operationId'], record)
            windows = self._windows(request['app'], client, deadline)
            if windows:
                window = windows[-1]  # Original xdotool order: last visible matching window wins.
                self._activate(window, request['app'], client, deadline)
                record.update(window=window, phase='visible')
                self._write(request['operationId'], record)
                return self._reply(request, 'focused', window['windowId'])
            if not os.access(APPS[request['app']][0], os.X_OK):
                return self._reply(request, 'app-missing', None)
            self._check(client, deadline)
            if check_directory(WORKSPACE) != workspace_identity:
                raise LauncherError('interrupted')
            record['phase'] = 'starting'
            self._write(request['operationId'], record)  # Crash after this point never respawns.
            proc = subprocess.Popen(launch_vector(request['app']), cwd=WORKSPACE, env=self._environment(),
                                    stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                    shell=False, start_new_session=True)
            self.children = [child for child in self.children if child.poll() is None]
            self.children.append(proc)
            # Capture the startup identity even before the child finishes exec.
            start = self._start(proc.pid)
            self.track_child(proc)
            while True:
                self._check(client, deadline)
                windows = self._windows(request['app'], client, deadline)
                if windows:
                    visible = True
                    window = windows[-1]
                    self._activate(window, request['app'], client, deadline)
                    record.update(window=window, phase='visible')
                    self._write(request['operationId'], record)
                    visible = True
                    return self._reply(request, 'opened', window['windowId'])
                if proc.poll() is not None and proc.returncode != 0:
                    raise LauncherError('interrupted')
                time.sleep(0.05)
        except LauncherError as error:
            if error.state in ('timeout', 'interrupted'):
                return self._reply(request, error.state, None)
            raise
        finally:
            # Never close/focus/kill a previously opened user window on cancellation.
            if not visible:
                self._stop_new(proc, start)
            self.lock.release()

    @staticmethod
    def _reply(request, status, window):
        return {'ok': True, 'operationId': request['operationId'], 'fingerprint': request['fingerprint'],
                'app': request['app'], 'status': status, 'windowId': window}

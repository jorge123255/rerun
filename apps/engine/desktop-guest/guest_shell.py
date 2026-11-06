#!/usr/bin/env python3
"""Bounded commands in the isolated workspace; immutable command IDs, fresh RPC IDs."""
import ctypes
import hashlib
import hmac
import json
import itertools
import os
from pathlib import Path
import re
import selectors
import signal
import stat
import subprocess
import sys
import threading
import time
import tool_install

OUTPUT_MAX = 50_000
COMMAND_MAX = 16_000
TIMEOUT_MAX = 600_000
WORKSPACE = '/home/rerun/workspace'
RECEIPTS = '/var/lib/rerun/profile/guest-shell-receipts'
HEX32 = re.compile(r'^[a-f0-9]{32}$')
HEX64 = re.compile(r'^[a-f0-9]{64}$')

class GuestShellError(Exception):
    pass

def minimal_environment(workspace):
    return {'PATH': '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', 'HOME': '/home/rerun', 'LANG': 'C.UTF-8', 'LC_ALL': 'C.UTF-8', 'RERUN_WORKSPACE': workspace, 'NODE_PATH': os.path.join(workspace, 'node_modules')}

def secure_cwd(workspace, requested):
    if not isinstance(requested, str) or len(requested) > 256 or '\x00' in requested or '\\' in requested or requested.startswith('/') or (requested and any(p in ('', '.', '..') for p in requested.split('/'))):
        raise GuestShellError('Working directory must stay inside the guest workspace.')
    root = os.path.realpath(workspace)
    target = os.path.realpath(os.path.join(root, requested))
    if os.path.commonpath([root, target]) != root or not os.path.isdir(target):
        raise GuestShellError('Working directory must stay inside the guest workspace.')
    current = root
    for part in requested.split('/'):
        if part:
            current = os.path.join(current, part)
            if os.path.islink(current):
                raise GuestShellError('Working directory links are not allowed.')
    return target

def package_evidence(expected):
    if expected is None:
        return None
    if not isinstance(expected, list) or not 1 <= len(expected) <= 8:
        raise GuestShellError('Reviewed package evidence is invalid.')
    for item in expected:
        if not isinstance(item, dict) or set(item) != {'package', 'manifestSha256', 'lockSha256'} or not isinstance(item['package'], str) or not tool_install.TARGET.fullmatch(item['package']) or not all(isinstance(item[k], str) and HEX64.fullmatch(item[k]) for k in ('manifestSha256', 'lockSha256')):
            raise GuestShellError('Reviewed package evidence is invalid.')
    actual = tool_install.evidence([item['package'] for item in expected])
    rows = [{k: item.get(k) for k in ('package', 'manifestSha256', 'lockSha256')} for item in actual]
    if any(item.get('status') != 'installed' for item in actual) or rows != expected:
        raise GuestShellError('Reviewed package evidence changed in this guest.')
    return rows

def empty(command_id, status, message):
    return {'requestId': command_id, 'status': status, 'stdout': '', 'stderr': '', 'exitCode': None, 'durationMs': 0, 'message': message}

def kill_descendants():
    # This process is a Linux child subreaper. Double-forked/setsid children are adopted here.
    deadline = time.monotonic() + 4
    children_file = Path(f'/proc/{os.getpid()}/task/{os.getpid()}/children')
    while time.monotonic() < deadline:
        children = [int(pid) for pid in children_file.read_text().split()]
        for pid in children:
            try:
                os.kill(pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        while True:
            try:
                pid, _ = os.waitpid(-1, os.WNOHANG)
                if pid == 0:
                    break
            except ChildProcessError:
                break
        if not children_file.read_text().strip():
            return True
        time.sleep(0.01)
    return False

def child(command, receipt_fd):
    # The shell never inherits this acknowledgement descriptor.
    if ctypes.CDLL(None, use_errno=True).prctl(36, 1, 0, 0, 0) != 0:
        return 255
    def stop(_signum, _frame):
        raise InterruptedError('Command stopped')
    signal.signal(signal.SIGTERM, stop)
    code = 255
    try:
        process = subprocess.Popen(['/bin/sh', '-c', command], stdin=subprocess.DEVNULL, close_fds=True)
        code = process.wait()
        code = code if code >= 0 else min(255, 128 - code)
    except InterruptedError:
        code = 143
    finally:
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        if kill_descendants():
            os.write(receipt_fd, b'D')
        os.close(receipt_fd)
    return code

class GuestShellManager:
    def __init__(self, workspace=WORKSPACE, receipts=RECEIPTS):
        self.workspace = os.path.realpath(workspace)
        self.receipts = Path(receipts)
        self.key = os.urandom(32)
        self.lock = threading.RLock()
        self.active = {}
        self.seen = set()
        tool_install.directory(self.receipts)

    def validate(self, request, execute=False):
        allowed = {'op', 'requestId', 'commandId', 'workspaceFingerprint'} | ({'fingerprint', 'command', 'timeoutMs', 'cwd', 'expectedPackageEvidence'} if execute else set())
        if not isinstance(request, dict) or set(request) - allowed:
            raise GuestShellError('Guest command request is invalid.')
        command_id, workspace = request.get('commandId'), request.get('workspaceFingerprint')
        if not isinstance(command_id, str) or not HEX32.fullmatch(command_id) or not isinstance(workspace, str) or not HEX64.fullmatch(workspace):
            raise GuestShellError('Guest command identity is invalid.')
        if tool_install.read_bytes(tool_install.WORKSPACE / '.rerun-install-workspace', 256).decode().strip() != workspace or os.path.realpath(tool_install.WORKSPACE) != self.workspace:
            raise GuestShellError('Guest command workspace changed.')
        return command_id

    def path(self, command_id):
        return self.receipts / (command_id + '.json')

    def read(self, command_id):
        path = self.path(command_id)
        try:
            sealed = json.loads(tool_install.read_bytes(path, 700_000))
        except FileNotFoundError:
            if command_id in self.seen:
                raise GuestShellError('Guest command receipt was removed; it cannot run again.')
            return None
        except (OSError, ValueError, tool_install.InstallError) as error:
            raise GuestShellError('Guest command receipt cannot be authenticated.') from error
        value, mac = sealed.get('payload'), sealed.get('mac')
        if not isinstance(value, dict) or not isinstance(mac, str) or not hmac.compare_digest(mac, hmac.new(self.key, tool_install.receipt_bytes(value), hashlib.sha256).hexdigest()):
            raise GuestShellError('Guest command receipt cannot be authenticated.')
        self.seen.add(command_id)
        if value.get('result', {}).get('requestId') != command_id:
            raise GuestShellError('Guest command receipt changed.')
        return value

    def write(self, command_id, fingerprint, result):
        value = {'fingerprint': fingerprint, 'result': result}
        tool_install.atomic(self.path(command_id), {'payload': value, 'mac': hmac.new(self.key, tool_install.receipt_bytes(value), hashlib.sha256).hexdigest()})
        self.seen.add(command_id)

    def inspect(self, request):
        command_id = self.validate(request)
        with self.lock:
            active = self.active.get(command_id)
            if active:
                return empty(command_id, 'interrupted', 'Command is still running. Inspect this same request later.')
            value = self.read(command_id)
            return value['result'] if value else empty(command_id, 'unavailable', 'No command receipt is available. This request must not be executed again.')

    def cancel(self, request):
        command_id = self.validate(request)
        with self.lock:
            state = self.active.get(command_id)
            if state:
                state['cancel'].set()
            else:
                value = self.read(command_id)
                if not value or value['result']['status'] in ('interrupted', 'unavailable'):
                    raise GuestShellError('Command drain cannot be confirmed.')
                return {'requestId': command_id, 'drained': True}
        if not state['done'].wait(8) or not state.get('drained'):
            raise GuestShellError('Command drain cannot be confirmed.')
        return {'requestId': command_id, 'drained': True}

    def execute(self, request, cancelled=lambda: False):
        command_id = self.validate(request, True)
        command, fingerprint = request.get('command'), request.get('fingerprint')
        timeout = request.get('timeoutMs', 120_000)
        if not isinstance(command, str) or not command.strip() or len(command) > COMMAND_MAX or '\x00' in command or not isinstance(fingerprint, str) or not HEX64.fullmatch(fingerprint):
            raise GuestShellError('Guest command is invalid.')
        if isinstance(timeout, bool) or not isinstance(timeout, int) or not 1 <= timeout <= TIMEOUT_MAX:
            raise GuestShellError('Guest command timeout is invalid.')
        cwd = secure_cwd(self.workspace, request.get('cwd', ''))
        evidence = package_evidence(request.get('expectedPackageEvidence'))
        with self.lock:
            prior = self.read(command_id)
            if prior:
                if prior['fingerprint'] != fingerprint:
                    raise GuestShellError('Guest command identity conflict.')
                return self.inspect({'op': 'guest-shell-inspect', 'commandId': command_id, 'workspaceFingerprint': request['workspaceFingerprint']})
            if len(self.seen) >= 4096 or sum(1 for _ in itertools.islice(self.receipts.iterdir(), 4096)) >= 4096:
                raise GuestShellError('Guest command receipt capacity reached.')
            if cancelled():
                raise GuestShellError('Command was cancelled before admission.')
            self.write(command_id, fingerprint, empty(command_id, 'interrupted', 'Command reserved; inspect before retrying.'))
            state = {'cancel': threading.Event(), 'done': threading.Event(), 'drained': False}
            self.active[command_id] = state
        process = None
        selector = selectors.DefaultSelector()
        stdout, stderr = bytearray(), bytearray()
        started = time.monotonic()
        status, message, code = 'interrupted', None, None
        read_ack, write_ack = os.pipe()
        os.set_blocking(read_ack, False)
        try:
            process = subprocess.Popen([sys.executable, os.path.realpath(__file__), '--child', str(write_ack), command], cwd=cwd, env=minimal_environment(self.workspace), stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, pass_fds=(write_ack,), start_new_session=True)
            os.close(write_ack); write_ack = None
            for stream, output in ((process.stdout, stdout), (process.stderr, stderr)):
                os.set_blocking(stream.fileno(), False)
                selector.register(stream, selectors.EVENT_READ, output)
            deadline, drain_deadline = started + timeout / 1000, None
            status = 'done'
            while process.poll() is None or selector.get_map():
                now = time.monotonic()
                if drain_deadline is None and (state['cancel'].is_set() or cancelled() or now >= deadline):
                    status = 'cancelled' if state['cancel'].is_set() or cancelled() else 'timeout'
                    process.terminate(); drain_deadline = now + 6
                if drain_deadline is not None and now >= drain_deadline:
                    process.kill(); status = 'interrupted'; break
                for selected, _ in selector.select(0.03):
                    data = os.read(selected.fd, 8192)
                    if not data:
                        selector.unregister(selected.fileobj); continue
                    output = selected.data
                    room = max(0, OUTPUT_MAX - len(output))
                    output.extend(data[:room])
                    if len(data) > room and drain_deadline is None:
                        status, message = 'failed', 'Command output exceeded its limit.'
                        process.terminate(); drain_deadline = now + 6
                if process.poll() is not None and drain_deadline is None:
                    drain_deadline = now + 1
            process.wait(timeout=2)
            state['drained'] = os.read(read_ack, 1) == b'D'
            if not state['drained']:
                status, message = 'interrupted', 'The command process tree could not be confirmed stopped.'
            elif status == 'done' and process.returncode != 0:
                status = 'failed'
            code = process.returncode if status in ('done', 'failed') and 0 <= process.returncode <= 255 else None
        except (OSError, subprocess.SubprocessError):
            status, message = 'interrupted', 'The command outcome could not be confirmed.'
        finally:
            if process is not None and process.poll() is None:
                process.kill()
                try:
                    process.wait(timeout=2)
                except subprocess.TimeoutExpired:
                    pass
            selector.close()
            for stream in (getattr(process, 'stdout', None), getattr(process, 'stderr', None)):
                if stream:
                    stream.close()
            os.close(read_ack)
            if write_ack is not None:
                os.close(write_ack)
            result = {'requestId': command_id, 'status': status, 'stdout': stdout.decode('utf-8', 'replace')[:OUTPUT_MAX], 'stderr': stderr.decode('utf-8', 'replace')[:OUTPUT_MAX], 'exitCode': code, 'durationMs': max(0, round((time.monotonic() - started) * 1000)), **({'packageEvidence': evidence} if evidence else {}), **({'message': message} if message else {})}
            with self.lock:
                try:
                    self.write(command_id, fingerprint, result)
                finally:
                    self.active.pop(command_id, None)
                    state['done'].set()
        return result

if __name__ == '__main__':
    if len(sys.argv) == 4 and sys.argv[1] == '--child':
        sys.exit(child(sys.argv[3], int(sys.argv[2])))
    raise SystemExit('Guest commands are available only through the authenticated guest service.')

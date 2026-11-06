#!/usr/bin/env python3
"""Bounded, receipted shell commands inside the isolated guest workspace."""

import json
import os
import re
import signal
import subprocess
import threading
import time

OUTPUT_MAX = 50_000
COMMAND_MAX = 16_000
TIMEOUT_MAX = 600_000
WORKSPACE = '/var/lib/rerun/profile/workspace'
RECEIPTS = '/var/lib/rerun/profile/.guest-shell-receipts'
INSTALL_RECEIPT = '/var/lib/rerun/profile/tool-install-receipt.json'
PACKAGE_TARGET = re.compile(r'^(?:@[a-z0-9][a-z0-9._-]*/)?[a-z0-9][a-z0-9._-]*@[a-z0-9][a-z0-9._+~-]*$')
STATUSES = {'done', 'failed', 'timeout', 'cancelled', 'interrupted', 'unavailable'}


class GuestShellError(Exception):
    pass


def minimal_environment(workspace):
    return {
        'PATH': '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
        'HOME': '/home/rerun',
        'LANG': 'C.UTF-8',
        'LC_ALL': 'C.UTF-8',
        'RERUN_WORKSPACE': workspace,
        'NODE_PATH': '/var/lib/rerun/profile/node_modules',
    }


def request_id(request):
    value = request.get('requestId') if isinstance(request, dict) else None
    if not isinstance(value, str) or not re.fullmatch(r'[a-f0-9]{32}', value):
        raise GuestShellError('Guest command needs an exact request identity.')
    return value


def secure_cwd(workspace, requested):
    if not isinstance(requested, str) or len(requested) > 256 or '\x00' in requested or '\\' in requested or requested.startswith('/'):
        raise GuestShellError('Working directory must stay inside the guest workspace.')
    if any(part in ('', '.', '..') for part in requested.split('/')):
        if requested:
            raise GuestShellError('Working directory must stay inside the guest workspace.')
    target = os.path.realpath(os.path.join(workspace, requested))
    if os.path.commonpath([workspace, target]) != workspace or not os.path.isdir(target):
        raise GuestShellError('Working directory must stay inside the guest workspace.')
    current = workspace
    for part in requested.split('/'):
        if not part:
            continue
        current = os.path.join(current, part)
        if os.path.islink(current):
            raise GuestShellError('Working directory links are not allowed.')
    return target


def package_evidence(packages):
    if packages is None:
        return None
    if not isinstance(packages, list) or len(packages) > 8:
        raise GuestShellError('Package targets are invalid.')
    for target in packages:
        if not isinstance(target, str) or not PACKAGE_TARGET.fullmatch(target):
            raise GuestShellError(f'{target} is not an exact reviewed package target.')
    try:
        with open(INSTALL_RECEIPT, encoding='utf-8') as handle:
            receipt = json.load(handle)
    except (OSError, ValueError) as error:
        raise GuestShellError('Reviewed package evidence is unavailable.') from error
    rows = receipt.get('packages') if isinstance(receipt, dict) else None
    if not isinstance(rows, list):
        raise GuestShellError('Reviewed package evidence is unavailable.')
    evidence = []
    for target in packages:
        matches = [row for row in rows if isinstance(row, dict) and row.get('package') == target and row.get('status') == 'installed']
        if len(matches) != 1:
            raise GuestShellError(f'{target} is not installed with reviewed evidence in this guest.')
        row = matches[0]
        manifest = row.get('manifestSha256')
        lock = row.get('lockSha256')
        if not isinstance(manifest, str) or not re.fullmatch(r'[a-f0-9]{64}', manifest) or not isinstance(lock, str) or not re.fullmatch(r'[a-f0-9]{64}', lock):
            raise GuestShellError(f'{target} has incomplete installation evidence.')
        evidence.append({'package': target, 'manifestSha256': manifest, 'lockSha256': lock})
    return evidence


def read_receipt(path, request_id):
    try:
        with open(path, encoding='utf-8') as handle:
            value = json.load(handle)
    except (OSError, ValueError):
        return None
    if not isinstance(value, dict) or value.get('requestId') != request_id or value.get('status') not in STATUSES:
        return None
    if not isinstance(value.get('stdout'), str) or not isinstance(value.get('stderr'), str) or not isinstance(value.get('durationMs'), int):
        return None
    if len(value['stdout']) > OUTPUT_MAX or len(value['stderr']) > OUTPUT_MAX or value['durationMs'] < 0:
        return None
    if value.get('exitCode') is not None and (not isinstance(value['exitCode'], int) or isinstance(value['exitCode'], bool) or not 0 <= value['exitCode'] <= 255):
        return None
    return value


def write_receipt(path, receipt):
    temporary = f'{path}.{os.getpid()}.tmp'
    try:
        with open(temporary, 'x', encoding='utf-8') as handle:
            json.dump(receipt, handle, separators=(',', ':'), ensure_ascii=False)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def pump(stream, chunks, overflow, process_pid):
    try:
        data = stream.read(OUTPUT_MAX + 1)
        if len(data) > OUTPUT_MAX:
            overflow.set()
            os.killpg(process_pid, signal.SIGKILL)
        else:
            chunks.append(data)
    except Exception:
        overflow.set()


class GuestShellManager:
    def __init__(self, workspace=WORKSPACE, receipts=RECEIPTS):
        self.workspace = os.path.realpath(workspace)
        self.receipts = os.path.realpath(receipts)
        os.makedirs(self.workspace, exist_ok=True)
        os.makedirs(self.receipts, exist_ok=True)
        self.active = {}
        self.partial = {}
        self.lock = threading.Lock()

    def receipt_path(self, request_id):
        return os.path.join(self.receipts, f'{request_id}.json')

    def owns(self, request_id):
        return request_id in self.active or os.path.exists(self.receipt_path(request_id))

    def inspect(self, request_id):
        if not isinstance(request_id, str) or not re.fullmatch(r'[a-f0-9]{32}', request_id):
            raise GuestShellError('Guest command needs an exact request identity.')
        with self.lock:
            active = self.active.get(request_id)
            if active is not None:
                return {'requestId': request_id, 'status': 'interrupted', 'stdout': '', 'stderr': '', 'exitCode': None, 'durationMs': 0, 'message': 'Command is still running.'}
            receipt = read_receipt(self.receipt_path(request_id), request_id)
            if receipt is not None:
                return receipt
            return {'requestId': request_id, 'status': 'unavailable', 'stdout': '', 'stderr': '', 'exitCode': None, 'durationMs': 0, 'message': 'No command receipt is available for this request.'}

    def execute(self, request):
        request_id = globals()['request_id'](request)
        command = request.get('command')
        if not isinstance(command, str) or not command.strip() or len(command) > COMMAND_MAX or '\x00' in command:
            raise GuestShellError('Command is empty or exceeds its limit.')
        timeout = request.get('timeoutMs', 120_000)
        if isinstance(timeout, bool) or not isinstance(timeout, int) or not 1 <= timeout <= TIMEOUT_MAX:
            raise GuestShellError('Command timeout is invalid.')
        cwd = secure_cwd(self.workspace, request.get('cwd', ''))
        evidence = package_evidence(request.get('packages'))
        path = self.receipt_path(request_id)
        with self.lock:
            if request_id in self.active:
                raise GuestShellError('This command is already running; inspect it instead of launching another.')
            existing = read_receipt(path, request_id)
            if existing is not None:
                return existing
            started = time.monotonic()
            reservation = {'requestId': request_id, 'status': 'interrupted', 'stdout': '', 'stderr': '', 'exitCode': None, 'durationMs': 0, 'message': 'Command was interrupted before execution.'}
            write_receipt(path, reservation)
            try:
                process = subprocess.Popen(
                    ['/bin/sh', '-c', command], cwd=cwd, env=minimal_environment(self.workspace),
                    stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                    start_new_session=True,
                )
            except OSError as error:
                raise GuestShellError('The guest command could not start.') from error
            self.active[request_id] = process
        stdout, stderr, overflow = [], [], threading.Event()
        self.partial[request_id] = (stdout, stderr)
        readers = [
            threading.Thread(target=pump, args=(process.stdout, stdout, overflow, process.pid), daemon=True),
            threading.Thread(target=pump, args=(process.stderr, stderr, overflow, process.pid), daemon=True),
        ]
        for reader in readers:
            reader.start()
        status = 'done'
        try:
            try:
                process.wait(timeout=timeout / 1000)
            except subprocess.TimeoutExpired:
                status = 'timeout'
                os.killpg(process.pid, signal.SIGKILL)
            if overflow.is_set() or process.returncode not in (0, None):
                status = 'failed'
            process.wait()
        except Exception:
            status = 'interrupted'
            os.killpg(process.pid, signal.SIGKILL)
        finally:
            for reader in readers:
                reader.join(timeout=1)
            with self.lock:
                self.active.pop(request_id, None)
                self.partial.pop(request_id, None)
        result = {
            'requestId': request_id,
            'status': status,
            'stdout': b''.join(stdout).decode('utf-8', errors='replace')[:OUTPUT_MAX],
            'stderr': b''.join(stderr).decode('utf-8', errors='replace')[:OUTPUT_MAX],
            'exitCode': process.returncode if status != 'timeout' else None,
            'durationMs': max(0, round((time.monotonic() - started) * 1000)),
            **({'packageEvidence': evidence} if evidence is not None else {}),
            **({'message': 'Command output exceeded its limit.'} if overflow.is_set() else {}),
        }
        write_receipt(path, result)
        return result

    def cancel(self, request_id):
        if not isinstance(request_id, str) or not re.fullmatch(r'[a-f0-9]{32}', request_id):
            raise GuestShellError('Guest command needs an exact request identity.')
        with self.lock:
            process = self.active.get(request_id)
            if process is None:
                existing = read_receipt(self.receipt_path(request_id), request_id)
                return existing if existing is not None else {'requestId': request_id, 'status': 'cancelled', 'stdout': '', 'stderr': '', 'exitCode': None, 'durationMs': 0, 'message': 'Command was cancelled before launch.'}
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            try:
                process.wait()
            except Exception:
                pass
            stdout, stderr = self.partial.get(request_id, ([], []))
            result = {'requestId': request_id, 'status': 'cancelled', 'stdout': b''.join(stdout).decode('utf-8', errors='replace')[:OUTPUT_MAX], 'stderr': b''.join(stderr).decode('utf-8', errors='replace')[:OUTPUT_MAX], 'exitCode': None, 'durationMs': 0, 'message': 'Command was cancelled.'}
            write_receipt(self.receipt_path(request_id), result)
            self.active.pop(request_id, None)
            self.partial.pop(request_id, None)
            return result


def main():
    import sys
    request = json.loads(sys.stdin.buffer.read())
    manager = GuestShellManager()
    operation = request.get('op')
    if operation == 'guest-shell':
        result = manager.execute(request)
    elif operation == 'guest-shell-inspect':
        result = manager.inspect(request.get('requestId'))
    elif operation == 'cancel':
        result = manager.cancel(request.get('requestId'))
    else:
        raise GuestShellError('That guest action is not available.')
    sys.stdout.buffer.write(json.dumps(result, separators=(',', ':'), ensure_ascii=False).encode())
    sys.stdout.buffer.flush()


if __name__ == '__main__':
    main()

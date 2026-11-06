"""Fixed reviewed npm installation in the isolated coworker workspace."""
import fcntl
import hashlib
import hmac
import json
import os
import re
import selectors
import signal
import stat
import subprocess
import time
from pathlib import Path

WORKSPACE = Path('/home/rerun/workspace')
JOURNAL = Path('/var/lib/rerun/profile/tool-install-receipts')
TARGET = re.compile(r'^(@[a-z0-9][a-z0-9._-]*/)?[a-z0-9][a-z0-9._-]*@(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$')
HEX = re.compile(r'^[a-f0-9]{64}$')
MAX_FILE = 4 * 1024 * 1024
RECEIPT_KEY = os.urandom(32)

class InstallError(Exception):
    pass

def directory(path):
    path.mkdir(mode=0o700, parents=True, exist_ok=True)
    info = path.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid():
        raise InstallError('Installation directory changed.')

def read_bytes(path, cap=MAX_FILE):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_uid != os.getuid() or info.st_size > cap:
            raise InstallError('Installation evidence is invalid.')
        data = os.read(fd, cap + 1)
        if len(data) > cap:
            raise InstallError('Installation evidence is too large.')
        return data
    finally:
        os.close(fd)

def atomic(path, value):
    data = json.dumps(value, separators=(',', ':'), sort_keys=True).encode()
    temporary = path.with_name('.' + path.name + '.' + os.urandom(12).hex())
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        with os.fdopen(fd, 'wb') as out:
            out.write(data)
            out.flush()
            os.fsync(out.fileno())
        os.replace(temporary, path)
        directory_fd = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
    finally:
        temporary.unlink(missing_ok=True)

def receipt_bytes(value):
    return json.dumps(value, separators=(',', ':'), sort_keys=True).encode()

def seal_receipt(path, value):
    atomic(path, {'payload': value, 'mac': hmac.new(RECEIPT_KEY, receipt_bytes(value), hashlib.sha256).hexdigest()})

def read_receipt(path):
    sealed = json.loads(read_bytes(path, 100000))
    value, mac = sealed.get('payload'), sealed.get('mac')
    if not isinstance(value, dict) or not isinstance(mac, str) or not hmac.compare_digest(mac, hmac.new(RECEIPT_KEY, receipt_bytes(value), hashlib.sha256).hexdigest()):
        # Old/changed receipts remain tombstones; never adopt them as new executable work.
        raise InstallError('Installation receipt cannot be authenticated in this guest.')
    return value


def initialize():
    directory(WORKSPACE)
    directory(JOURNAL)
    marker = WORKSPACE / '.rerun-install-workspace'
    try:
        fingerprint = read_bytes(marker, 256).decode().strip()
    except FileNotFoundError:
        fingerprint = os.urandom(32).hex()
        fd = os.open(marker, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        try:
            os.write(fd, fingerprint.encode())
            os.fsync(fd)
        finally:
            os.close(fd)
    if not HEX.fullmatch(fingerprint):
        raise InstallError('Installation workspace changed.')
    manifest = WORKSPACE / 'package.json'
    if not manifest.exists():
        atomic(manifest, {'name': 'rerun-isolated-workspace', 'version': '1.0.0', 'private': True})
    return fingerprint

def validate(request):
    if set(request) - {'op', 'mode', 'operationId', 'workspaceFingerprint', 'packages', 'requestId'}:
        raise InstallError('Invalid installation request.')
    if request.get('op') != 'tool-install' or request.get('mode') not in ('probe', 'install', 'inspect'):
        raise InstallError('Invalid installation mode.')
    if request['mode'] == 'probe':
        if set(request) - {'op', 'mode', 'requestId'}:
            raise InstallError('Invalid capability request.')
        return
    packages = request.get('packages')
    if not isinstance(packages, list) or not 1 <= len(packages) <= 8 or any(not isinstance(p, str) or len(p) > 300 or not TARGET.fullmatch(p) for p in packages):
        raise InstallError('Exact package versions are required.')
    if len({p.rsplit('@', 1)[0] for p in packages}) != len(packages):
        raise InstallError('Conflicting package versions.')
    if not isinstance(request.get('operationId'), str) or not HEX.fullmatch(request['operationId']) or not isinstance(request.get('workspaceFingerprint'), str) or not HEX.fullmatch(request['workspaceFingerprint']):
        raise InstallError('Invalid installation identity.')

def evidence(packages):
    manifest_bytes = read_bytes(WORKSPACE / 'package.json')
    lock_bytes = read_bytes(WORKSPACE / 'package-lock.json')
    manifest, lock = json.loads(manifest_bytes), json.loads(lock_bytes)
    outcomes = []
    for target in packages:
        name, version = target.rsplit('@', 1)
        installed = json.loads(read_bytes(WORKSPACE / 'node_modules' / name / 'package.json'))
        locked = lock.get('packages', {}).get('node_modules/' + name, {})
        declared = manifest.get('dependencies', {}).get(name)
        if installed.get('name') != name or installed.get('version') != version or locked.get('version') != version or declared not in (version, '^' + version, '~' + version):
            outcomes.append({'package': target, 'status': 'uncertain', 'message': 'The installed version could not be verified.'})
        else:
            outcomes.append({'package': target, 'status': 'installed', 'manifestSha256': hashlib.sha256(manifest_bytes).hexdigest(), 'lockSha256': hashlib.sha256(lock_bytes).hexdigest()})
    return outcomes

def uncertain(packages, message):
    return {'status': 'uncertain', 'packages': [{'package': p, 'status': 'uncertain'} for p in packages], 'message': message}

def dispatch(request, client, cancelled):
    validate(request)
    fingerprint = initialize()
    if request['mode'] == 'probe':
        return {'ok': True, 'workspaceFingerprint': fingerprint, 'available': os.path.isfile('/usr/bin/npm') and os.access('/usr/bin/npm', os.X_OK)}
    if request['workspaceFingerprint'] != fingerprint:
        raise InstallError('This installation belongs to another workspace.')
    packages, operation_id = request['packages'], request['operationId']
    path = JOURNAL / (operation_id + '.json')
    lock_fd = os.open(JOURNAL / '.lock', os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    try:
        while True:
            if cancelled(client):
                raise InstallError('Installation was cancelled before admission.')
            try:
                fcntl.flock(lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                time.sleep(0.025)
        try:
            prior = read_receipt(path)
        except FileNotFoundError:
            prior = None
        identity = {'operationId': operation_id, 'workspaceFingerprint': fingerprint, 'packages': packages}
        if prior and prior.get('identity') != identity:
            raise InstallError('Installation request conflict.')
        if request['mode'] == 'inspect':
            if prior is None:
                return {'ok': True, 'result': {'status': 'failed', 'packages': [{'package': p, 'status': 'failed'} for p in packages], 'message': 'This installation was not submitted.'}}
            if prior.get('result', {}).get('status') in ('installed', 'failed', 'cancelled'):
                return {'ok': True, 'result': prior['result']}
            try:
                outcomes = evidence(packages)
                result = {'status': 'installed' if all(p['status'] == 'installed' for p in outcomes) else 'uncertain', 'packages': outcomes}
            except (OSError, ValueError, InstallError):
                result = uncertain(packages, 'Installation evidence is incomplete. No packages were installed by inspection.')
            seal_receipt(path, {'identity': identity, 'phase': 'finished', 'result': result})
            return {'ok': True, 'result': result}
        if prior:
            return {'ok': True, 'result': prior.get('result') or uncertain(packages, 'This installation was already submitted. Inspect it; it will not be repeated.')}
        if len(list(JOURNAL.glob('*.json'))) >= 2048:
            raise InstallError('The installation receipt limit was reached.')
        if cancelled(client):
            raise InstallError('Installation was cancelled before submission.')
        seal_receipt(path, {'identity': identity, 'phase': 'submitted'})
        output = bytearray()
        process = None
        selector = selectors.DefaultSelector()
        interrupted = False
        try:
            process = subprocess.Popen(['/usr/bin/npm', 'install', '--no-fund', '--no-audit', '--', *packages], cwd=WORKSPACE,
                env={'PATH': '/usr/bin:/bin', 'HOME': '/home/rerun', 'LANG': 'C.UTF-8', 'npm_config_cache': '/tmp/rerun-npm-cache'},
                stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, shell=False, start_new_session=True)
            os.set_blocking(process.stdout.fileno(), False)
            selector.register(process.stdout, selectors.EVENT_READ)
            deadline = time.monotonic() + 300
            while process.poll() is None:
                if cancelled(client) or time.monotonic() >= deadline:
                    interrupted = True
                    break
                for key, _ in selector.select(0.05):
                    data = os.read(key.fd, 8192)
                    output.extend(data[:max(0, 80000 - len(output))])
            if interrupted:
                os.killpg(process.pid, signal.SIGKILL)
            process.wait(timeout=5)
            for _ in range(16):
                try:
                    data = os.read(process.stdout.fileno(), 8192)
                    if not data:
                        break
                    output.extend(data[:max(0, 80000 - len(output))])
                except BlockingIOError:
                    break
            if interrupted:
                result = uncertain(packages, 'Installation stopped before its result was confirmed.')
            else:
                try:
                    outcomes = evidence(packages)
                    result = {'status': 'installed' if process.returncode == 0 and all(p['status'] == 'installed' for p in outcomes) else 'partial', 'packages': outcomes}
                except (OSError, ValueError, InstallError):
                    result = uncertain(packages, 'Installation finished without complete package evidence.')
            result['output'] = re.sub(r'[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\u202a-\u202e\u2066-\u2069]', '', output.decode('utf8', 'replace'))[:20000]
        except (OSError, subprocess.SubprocessError):
            result = uncertain(packages, 'Installation could not be confirmed.')
        finally:
            if process is not None:
                try:
                    os.killpg(process.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                process.wait(timeout=5)
                if process.stdout:
                    process.stdout.close()
            selector.close()
        seal_receipt(path, {'identity': identity, 'phase': 'finished', 'result': result})
        return {'ok': True, 'result': result}
    finally:
        os.close(lock_fd)

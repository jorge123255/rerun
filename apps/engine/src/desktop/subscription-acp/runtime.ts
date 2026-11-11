import { spawn, type ChildProcess } from 'node:child_process'
import { linkSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { dataDir } from '../../config/paths.js'
import type { DesktopSubscriptionProvider } from '@rerun/contracts'
import { openDesktopSubscriptionAcpSession } from './session.js'

const runners = {
    'grok-build': {
        variable: 'RERUN_DESKTOP_GROK_BUILD_RUNNER',
        home: 'GROK_HOME',
        args: ['--no-auto-update', 'agent', 'stdio'],
        login: ['--no-auto-update', 'login', '--device-auth'],
    },
    'kimi-code': {
        variable: 'RERUN_DESKTOP_KIMI_CODE_RUNNER',
        home: 'KIMI_CODE_HOME',
        args: ['acp'],
        login: ['login', '--region', 'global'],
    },
} as const

const unavailable = () => new Error('The subscription provider runner is unavailable.')
const shutdownUnconfirmed = () => new Error('The subscription provider runner did not stop cleanly.')
type Worker = () => Promise<void>
const workers = new Map<DesktopSubscriptionProvider, Worker>()
let stopping = false

function ownedFile(path: string | undefined, executable = false) {
    if (!path || !isAbsolute(path)) throw unavailable()
    try {
        const info = lstatSync(path)
        if (info.isFile() && realpathSync(path) === path && info.nlink === 1 &&
            (info.mode & 0o022) === 0 && (!executable || (info.mode & 0o100) !== 0) &&
            (info.uid === 0 || info.uid === process.getuid?.())) return path
    } catch {
        // The caller gets a fixed error without local paths.
    }
    throw unavailable()
}

function bundlePaths(provider: DesktopSubscriptionProvider) {
    if (process.platform !== 'darwin' || process.arch !== 'arm64' || process.env.RERUN_DESKTOP_APP !== '1') {
        throw unavailable()
    }
    return {
        binary: ownedFile(process.env[runners[provider].variable], true),
        sandbox: ownedFile(process.env.RERUN_DESKTOP_SUBSCRIPTION_SANDBOX),
    }
}

export function desktopSubscriptionRunnerAvailable(provider: DesktopSubscriptionProvider) {
    try {
        bundlePaths(provider)
        workspaceRoot()
        return !stopping
    } catch {
        return false
    }
}

function ownedDirectory(path: string) {
    try {
        const info = lstatSync(path)
        if (info.isDirectory() && info.uid === process.getuid?.() && (info.mode & 0o077) === 0 &&
            realpathSync(path) === path) return path
    } catch {
        // Keep account paths out of errors.
    }
    throw unavailable()
}

function privateDirectory(path: string) {
    try {
        mkdirSync(path, { mode: 0o700 })
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw unavailable()
    }
    return ownedDirectory(path)
}

function workspaceRoot() {
    try {
        const root = dataDir()
        if (root === process.env.RERUN_DESKTOP_ENGINE_ROOT && isAbsolute(root) &&
            realpathSync(root) === root && lstatSync(root).isDirectory()) return root
    } catch {
        // Never fall back to the CLI's default data directory.
    }
    throw unavailable()
}

function providerDirectory(provider: DesktopSubscriptionProvider, create: boolean) {
    const root = workspaceRoot()
    const directory = create ? privateDirectory : ownedDirectory
    return directory(join(directory(join(root, 'subscription-providers')), provider))
}

function accountDirectories(profile: string) {
    return {
        profile,
        cwd: privateDirectory(join(profile, 'work')),
        home: privateDirectory(join(profile, 'home')),
        vendorHome: privateDirectory(join(profile, 'account')),
        temp: privateDirectory(join(profile, 'tmp')),
    }
}

const attemptIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

function attemptPath(providerRoot: string, attemptId: string) {
    if (!attemptIdPattern.test(attemptId)) throw unavailable()
    return join(providerRoot, 'device-' + attemptId)
}

export function desktopSubscriptionDeviceLoginAvailable(provider: DesktopSubscriptionProvider) {
    try {
        ownedFile(process.env.RERUN_DESKTOP_SUBSCRIPTION_LOGIN_SANDBOX)
        return desktopSubscriptionRunnerAvailable(provider)
    } catch {
        return false
    }
}

function readApproval(provider: DesktopSubscriptionProvider) {
    try {
        const providerRoot = providerDirectory(provider, false)
        const receipt = ownedFile(join(providerRoot, 'device-approval.json'))
        const info = lstatSync(receipt)
        if (info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0 || info.size > 100) return null
        const { id } = JSON.parse(readFileSync(receipt, 'utf8'))
        if (typeof id !== 'string') return null
        return { receipt, profile: ownedDirectory(attemptPath(providerRoot, id)) }
    } catch {
        return null
    }
}

export function desktopSubscriptionDeviceApproved(provider: DesktopSubscriptionProvider) {
    return readApproval(provider) !== null
}

export function forgetDesktopSubscriptionDeviceApproval(provider: DesktopSubscriptionProvider) {
    if (workers.has(provider)) throw unavailable()
    const saved = readApproval(provider)
    if (!saved) return
    unlinkSync(saved.receipt)
    rmSync(saved.profile, { recursive: true, force: true })
}

export function createDesktopSubscriptionDeviceAttempt(provider: DesktopSubscriptionProvider, id: string) {
    if (!desktopSubscriptionDeviceLoginAvailable(provider) || workers.has(provider)) throw unavailable()
    const providerRoot = providerDirectory(provider, true)
    const profile = attemptPath(providerRoot, id)
    mkdirSync(profile, { mode: 0o700 })
    const account = accountDirectories(ownedDirectory(profile))
    return {
        launch(proxy: string, port: number) {
            const { binary } = bundlePaths(provider)
            const sandbox = ownedFile(process.env.RERUN_DESKTOP_SUBSCRIPTION_LOGIN_SANDBOX)
            return spawnRunner(provider, { binary, sandbox }, account, runners[provider].login, { proxy, port })
        },
        approve() {
            if (workers.has(provider)) throw unavailable()
            ownedDirectory(profile)
            const temp = join(providerRoot, id + '.receipt.tmp')
            writeFileSync(temp, JSON.stringify({ id }), { flag: 'wx', mode: 0o600 })
            try { linkSync(temp, join(providerRoot, 'device-approval.json')) }
            finally { unlinkSync(temp) }
        },
        discard() {
            if (workers.has(provider)) throw unavailable()
            rmSync(ownedDirectory(profile), { recursive: true, force: true })
        },
    }
}

// The packaged policy denies process creation. Only this directly owned PID can run.
async function stopChild(child: ChildProcess, exited: Promise<true>) {
    if (!child.pid || child.exitCode !== null || child.signalCode !== null) return
    child.kill('SIGTERM')
    if (await Promise.race([exited, delay(600, false, { ref: false })])) return
    child.kill('SIGKILL')
    if (!await Promise.race([exited, delay(1_500, false, { ref: false })])) throw shutdownUnconfirmed()
}

/** Qualifies the installed runner using a workspace-owned account and an offline policy. */
export async function openOfflineDesktopSubscriptionRunner(provider: DesktopSubscriptionProvider) {
    const paths = bundlePaths(provider)
    const account = accountDirectories(providerDirectory(provider, true))
    const { child, dispose } = spawnRunner(provider, paths, account, runners[provider].args)
    child.stderr.resume()
    return openDesktopSubscriptionAcpSession({
        provider, cwd: account.cwd, channel: { input: child.stdout, output: child.stdin, dispose },
    })
}

function spawnRunner(
    provider: DesktopSubscriptionProvider,
    { binary, sandbox }: ReturnType<typeof bundlePaths>,
    { profile, cwd, home, vendorHome, temp }: ReturnType<typeof accountDirectories>,
    args: readonly string[],
    relay?: { proxy: string; port: number },
) {
    if (stopping || workers.has(provider)) throw unavailable()
    const definition = runners[provider]
    const child = spawn('/usr/bin/sandbox-exec', [
        '-D', `RUNNER=${binary}`, '-D', `RUNNER_DIR=${dirname(binary)}`, '-D', `PROFILE=${profile}`,
        ...(relay ? ['-D', `AUTH_RELAY=localhost:${relay.port}`] : []),
        '-f', sandbox, binary, ...args,
    ], {
        cwd,
        env: {
            PATH: '/usr/bin:/bin',
            HOME: home,
            TMPDIR: temp,
            TERM: 'dumb',
            LANG: 'en_US.UTF-8',
            TZ: 'UTC',
            [definition.home]: vendorHome,
            ...(provider === 'kimi-code' ? { KIMI_DISABLE_TELEMETRY: '1' } : {}),
            ...(relay ? {
                HTTPS_PROXY: relay.proxy, HTTP_PROXY: relay.proxy,
                https_proxy: relay.proxy, http_proxy: relay.proxy,
            } : {}),
        },
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
    })
    child.on('error', () => child.stdout.destroy())
    const exited = new Promise<true>(resolve => child.once('exit', () => resolve(true)))
    let draining: Promise<void> | undefined
    const dispose: Worker = () => draining ??= stopChild(child, exited).then(() => {
        workers.delete(provider)
    }).finally(() => {
        // Retain failed drains for the next service shutdown attempt.
        draining = undefined
    })
    workers.set(provider, dispose)
    return { child, dispose }
}

export async function stopDesktopSubscriptionRunners() {
    stopping = true
    const results = await Promise.allSettled([...workers.values()].map(close => close()))
    if (results.some(result => result.status === 'rejected')) throw shutdownUnconfirmed()
}

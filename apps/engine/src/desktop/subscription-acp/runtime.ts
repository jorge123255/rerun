import { spawn, type ChildProcess } from 'node:child_process'
import { lstatSync, mkdirSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { dataDir } from '../../config/paths.js'
import { openDesktopSubscriptionAcpSession } from './session.js'

const runners = {
    'grok-build': {
        variable: 'RERUN_DESKTOP_GROK_BUILD_RUNNER',
        home: 'GROK_HOME',
        args: ['--no-auto-update', 'agent', 'stdio'],
    },
    'kimi-code': {
        variable: 'RERUN_DESKTOP_KIMI_CODE_RUNNER',
        home: 'KIMI_CODE_HOME',
        args: ['acp'],
    },
} as const

export type DesktopSubscriptionProvider = keyof typeof runners
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

function privateDirectory(path: string) {
    try {
        mkdirSync(path, { mode: 0o700 })
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw unavailable()
    }
    try {
        const info = lstatSync(path)
        if (info.isDirectory() && info.uid === process.getuid?.() && (info.mode & 0o077) === 0 &&
            realpathSync(path) === path) return path
    } catch {
        // Keep account paths out of errors.
    }
    throw unavailable()
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

function accountDirectories(provider: DesktopSubscriptionProvider) {
    const root = workspaceRoot()
    const base = privateDirectory(join(root, 'subscription-providers'))
    const profile = privateDirectory(join(base, provider))
    return {
        profile,
        cwd: privateDirectory(join(profile, 'work')),
        home: privateDirectory(join(profile, 'home')),
        vendorHome: privateDirectory(join(profile, 'account')),
        temp: privateDirectory(join(profile, 'tmp')),
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
    if (stopping || workers.has(provider)) throw unavailable()
    const { binary, sandbox } = bundlePaths(provider)
    const { profile, cwd, home, vendorHome, temp } = accountDirectories(provider)
    const definition = runners[provider]
    const child = spawn('/usr/bin/sandbox-exec', [
        '-D', `RUNNER=${binary}`, '-D', `RUNNER_DIR=${dirname(binary)}`, '-D', `PROFILE=${profile}`,
        '-f', sandbox, binary, ...definition.args,
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
        },
        shell: false,
        stdio: ['pipe', 'pipe', 'ignore'],
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
    return openDesktopSubscriptionAcpSession({
        provider, cwd, channel: { input: child.stdout, output: child.stdin, dispose },
    })
}

export async function stopDesktopSubscriptionRunners() {
    stopping = true
    const results = await Promise.allSettled([...workers.values()].map(close => close()))
    if (results.some(result => result.status === 'rejected')) throw shutdownUnconfirmed()
}

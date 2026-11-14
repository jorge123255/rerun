import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import { CONNECTION_TOKEN_KEY } from '@rerun/contracts'
import { env } from '../config/env.js'
import { codexHomeDir } from '../config/paths.js'
import { logger } from '../lib/logger.js'
import { ensureCodexAuth, syncCodexAuth } from './codex-auth.js'
import { planLimitWindowsFromCodex, recordPlanLimits, type CodexRateLimits } from './plan-limits.js'
import type { LoadedConnection } from './types.js'
import { desktopApp } from '../desktop/policy.js'
import { DESKTOP_CODEX_ID, signedInFlag } from '../desktop/codex-runtime.js'
import { findConnection } from './registry.js'
import { readDesktopCodexRateLimits } from '../desktop/codex-plan-limits.js'

const READ_TIMEOUT_MS = 8000
const STALE_AFTER_MS = 5 * 60_000

const INITIALIZE_ID = 1
const READ_ID = 2

type Command = { cmd: string; args: string[] }

// Same ladder as the provider's own resolution, so a reading and a run never use two binaries:
// the configured path, then the package the provider depends on, then whatever is on PATH.
function codexCommand(): Command {
    const { RERUN_CODEX_PATH } = env()
    if (RERUN_CODEX_PATH) return /\.[cm]?js$/i.test(RERUN_CODEX_PATH) ? { cmd: 'node', args: [RERUN_CODEX_PATH] } : { cmd: RERUN_CODEX_PATH, args: [] }
    try {
        const require = createRequire(import.meta.url)
        const fromProvider = createRequire(require.resolve('ai-sdk-provider-codex-cli'))
        return { cmd: 'node', args: [join(dirname(fromProvider.resolve('@openai/codex/package.json')), 'bin', 'codex.js')] }
    } catch {
        return { cmd: 'codex', args: [] }
    }
}

// The provider drops `account/rateLimits/updated` before anyone can see it and exposes no way to
// send a request of our own, so the reading takes a short app-server session: handshake, one
// read, gone. Resolves to null on any failure — a missing gauge is never worth an error.
export function readCodexRateLimits(connectionId: string): Promise<CodexRateLimits | null> {
    if (desktopApp()) return connectionId === DESKTOP_CODEX_ID ? readDesktopCodexRateLimits() : Promise.resolve(null)
    return new Promise(resolve => {
        const { cmd, args } = codexCommand()
        const home = codexHomeDir(connectionId)
        const child = spawn(cmd, [...args, 'app-server', '--listen', 'stdio://'], {
            stdio: ['pipe', 'pipe', 'ignore'],
            env: { PATH: process.env.PATH, HOME: process.env.HOME, USER: process.env.USER, TMPDIR: process.env.TMPDIR, LANG: process.env.LANG, CODEX_HOME: home, RUST_LOG: 'error' },
            cwd: home,
        })
        const lines = createInterface({ input: child.stdout, crlfDelay: Infinity })

        let settled = false
        const settle = (result: CodexRateLimits | null): void => {
            if (settled) return
            settled = true
            clearTimeout(timer)
            lines.close()
            child.kill('SIGTERM')
            resolve(result)
        }
        const timer = setTimeout(() => settle(null), READ_TIMEOUT_MS)
        const send = (message: Record<string, unknown>): void => {
            child.stdin.write(`${JSON.stringify(message)}\n`)
        }

        child.once('error', () => settle(null))
        child.once('close', () => settle(null))
        child.stdin.on('error', () => settle(null))
        lines.on('line', line => {
            let message: { id?: unknown; result?: unknown; error?: unknown }
            try {
                message = JSON.parse(line)
            } catch {
                return
            }
            if (message.id === INITIALIZE_ID) {
                if (message.error) return settle(null)
                send({ method: 'initialized' })
                send({ id: READ_ID, method: 'account/rateLimits/read' })
            } else if (message.id === READ_ID) {
                settle(message.error ? null : ((message.result ?? null) as CodexRateLimits | null))
            }
        })

        send({ id: INITIALIZE_ID, method: 'initialize', params: { clientInfo: { name: 'rerun-engine', version: '1' }, capabilities: { experimentalApi: true } } })
    })
}

const inFlight = new Map<string, Promise<void>>()
const attemptedAt = new Map<string, number>()
const desktopAttemptedAt = new WeakMap<LoadedConnection, number>()

export function pendingCodexPlanLimits(connectionId: string): Promise<void> | undefined {
    return inFlight.get(connectionId)
}

export function refreshCodexPlanLimits(connection: LoadedConnection | null): Promise<void> {
    if (!connection || connection.config.provider !== 'codex') return Promise.resolve()
    const desktop = desktopApp()
    if (desktop ? connection.id !== DESKTOP_CODEX_ID || connection.env[signedInFlag] !== '1' : !connection.env[CONNECTION_TOKEN_KEY.codex]) return Promise.resolve()

    const pending = inFlight.get(connection.id)
    if (pending) return pending

    if (desktop) desktopAttemptedAt.set(connection, Date.now())
    else attemptedAt.set(connection.id, Date.now())
    const task = (async () => {
        if (desktop) {
            const response = await readCodexRateLimits(connection.id)
            if (await findConnection(connection.id) === connection && connection.env[signedInFlag] === '1') {
                recordPlanLimits(connection.id, planLimitWindowsFromCodex(response))
            }
            return
        }
        await ensureCodexAuth(connection)
        const response = await readCodexRateLimits(connection.id)
        // The CLI may have rotated the token while it was up, exactly as it does during a run.
        await syncCodexAuth(connection)
        recordPlanLimits(connection.id, planLimitWindowsFromCodex(response))
    })()
        .catch(err => logger.warn({ connection: connection.id, err: (err as Error).message }, 'codex plan limits read failed'))
        .finally(() => inFlight.delete(connection.id))

    inFlight.set(connection.id, task)
    return task
}

// Called on the paths that must not wait for a process: the caller answers with the reading it
// has, and the fresh one is there for the next ask. Paced on the last attempt rather than the last
// reading, so a connection that cannot be read is not respawned on every list.
export function refreshStaleCodexPlanLimits(connections: LoadedConnection[]): void {
    for (const connection of connections) {
        const lastAttempt = desktopApp() ? desktopAttemptedAt.get(connection) : attemptedAt.get(connection.id)
        if (Date.now() - (lastAttempt ?? 0) < STALE_AFTER_MS) continue
        void refreshCodexPlanLimits(connection)
    }
}

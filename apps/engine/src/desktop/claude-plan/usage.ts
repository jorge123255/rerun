import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { DESKTOP_CLAUDE_CONNECTION_ID } from '@rerun/contracts'
import { planLimitWindowsFromClaude, recordPlanLimits, type ClaudePlanUsage } from '../../connections/plan-limits.js'
import type { LoadedConnection } from '../../connections/types.js'
import { logger } from '../../lib/logger.js'
import { desktopClaudeAvailable, desktopClaudeRuntime } from './runtime.js'

const READ_TIMEOUT_MS = 20_000
const EVERY_MS = 5 * 60_000
// The SDK ships the usage read under a name that says it will change; looked up by key so a
// renamed method costs the gauge and nothing else.
const USAGE_METHOD = 'usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET'

type SdkQuery = { close(): void } & Record<string, unknown>
type Sdk = { query(input: { prompt: AsyncIterable<never>; options: Record<string, unknown> }): SdkQuery }
let sdk: Promise<Sdk> | undefined
// The Agent SDK is the Claude provider's dependency, not the engine's own: resolved through it.
const loadSdk = () => sdk ??= (async () => {
    const provider = createRequire(createRequire(import.meta.url).resolve('ai-sdk-provider-claude-code'))
    return await import(pathToFileURL(provider.resolve('@anthropic-ai/claude-agent-sdk')).href) as Sdk
})()

/** Starts the sandboxed Claude runner, asks it for the plan usage, and stops it. No prompt is sent. */
export async function readDesktopClaudePlanUsage(token: string, harness: Record<string, string>, load: () => Promise<Sdk> = loadSdk): Promise<ClaudePlanUsage | null> {
    const runtime = desktopClaudeRuntime(DESKTOP_CLAUDE_CONNECTION_ID, token, harness)
    let release!: () => void
    const idle = new Promise<void>(resolve => { release = resolve })
    // An input that never speaks: the runner stays up for the one control request and nothing else.
    const prompt = { async *[Symbol.asyncIterator](): AsyncGenerator<never> { await idle } }
    let query: SdkQuery | undefined, timer: NodeJS.Timeout | undefined
    try {
        const { cwd, pathToClaudeCodeExecutable, settingSources, tools, strictMcpConfig, persistSession, permissionMode, spawnClaudeCodeProcess } = runtime.settings
        query = (await load()).query({ prompt, options: { cwd, pathToClaudeCodeExecutable, settingSources, tools, strictMcpConfig, persistSession, permissionMode, spawnClaudeCodeProcess, env: {} } })
        const reader = query[USAGE_METHOD]
        if (typeof reader !== 'function') return null
        return await Promise.race([
            Promise.resolve(reader.call(query, { skipBehaviors: true })) as Promise<ClaudePlanUsage>,
            new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Claude usage read timed out')), READ_TIMEOUT_MS) }),
        ])
    } catch (error) {
        logger.warn({ err: (error as Error).message }, 'claude plan usage read failed')
        return null
    } finally {
        clearTimeout(timer)
        release()
        try { query?.close() } catch { /* already gone */ }
        await runtime.close().catch(() => {})
    }
}

let reading: Promise<void> | undefined, attemptedAt = 0

/**
 * Keeps the Claude plan's limits current for the providers list: read when asked, at most every
 * five minutes. A reply still records them itself when it ends.
 */
export function refreshStaleDesktopClaudePlanLimits(connection: LoadedConnection, harness: Record<string, string>, read = readDesktopClaudePlanUsage, now = Date.now()): Promise<void> {
    const token = connection.env.CLAUDE_CODE_OAUTH_TOKEN
    if (connection.id !== DESKTOP_CLAUDE_CONNECTION_ID || !token || !desktopClaudeAvailable()) return Promise.resolve()
    if (reading) return reading
    if (now - attemptedAt < EVERY_MS) return Promise.resolve()
    attemptedAt = now
    return reading = read(token, harness)
        .then(usage => {
            const windows = planLimitWindowsFromClaude(usage)
            // Field names only: enough to tell a plan that reports nothing from an answer that changed shape.
            if (!windows.length && usage) logger.warn({ fields: Object.keys(usage), limits: Object.keys(usage.rate_limits ?? {}) }, 'claude plan usage had no windows')
            recordPlanLimits(connection.id, windows)
        })
        .catch(() => {})
        .finally(() => { reading = undefined })
}
export function resetDesktopClaudePlanLimitPacing() { attemptedAt = 0 }

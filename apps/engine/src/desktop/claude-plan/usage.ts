import { DESKTOP_CLAUDE_CONNECTION_ID } from '@rerun/contracts'
import { planLimitWindowsFromClaude, recordPlanLimits, type ClaudePlanUsage } from '../../connections/plan-limits.js'
import type { LoadedConnection } from '../../connections/types.js'
import { logger } from '../../lib/logger.js'
import { noteDesktopPlanUsage } from '../plan-usage-diagnostic.js'
import { desktopClaudeAvailable } from './runtime.js'

const READ_TIMEOUT_MS = 20_000
const EVERY_MS = 5 * 60_000
const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'
// The sign-in is a Claude Code one and the app runs the Claude Code runner with it, so the request
// carries that client's name. The endpoint throttles hard whatever the name (429 on November 14,
// 2026); the reading a reply carries is the one to count on.
const CLAUDE_CODE_USER_AGENT = 'claude-cli/2.1.322 (external, sdk-ts)'

/**
 * Asks Anthropic's own usage endpoint with the plan sign-in this engine already holds. The runner
 * started with that sign-in alone does not know the plan and answers that it has no limits to
 * report, so this is the reading that works; the token goes to its issuer and nowhere else.
 */
let refusedUntil = 0
export async function fetchDesktopClaudePlanUsage(token: string, request: typeof fetch = fetch): Promise<ClaudePlanUsage | null> {
    if (Date.now() < refusedUntil) return null
    try {
        const response = await request(USAGE_URL, {
            headers: { accept: 'application/json', authorization: `Bearer ${token}`, 'anthropic-beta': 'oauth-2025-04-20', 'user-agent': CLAUDE_CODE_USER_AGENT },
            redirect: 'error', signal: AbortSignal.timeout(READ_TIMEOUT_MS),
        })
        if (!response.ok) {
            logger.warn({ status: response.status }, 'claude plan usage endpoint refused')
            const wait = Number(response.headers.get('retry-after'))
            // The endpoint throttles hard; asking again soon only extends it.
            if (response.status === 429) refusedUntil = Date.now() + Math.min(6 * 60 * 60_000, Math.max(30 * 60_000, Number.isFinite(wait) ? wait * 1000 : 0))
            noteDesktopPlanUsage('claude', { outcome: `endpoint-refused${Number.isFinite(wait) && wait > 0 ? `:retry-after-${Math.round(wait)}s` : ''}`, status: response.status })
            return null
        }
        const body: unknown = await response.json()
        const usable = !!body && typeof body === 'object' && !Array.isArray(body)
        noteDesktopPlanUsage('claude', { outcome: usable ? 'endpoint-answered' : 'endpoint-unexpected', status: response.status, fields: usable ? Object.keys(body as object) : [] })
        return usable ? { rate_limits: body as ClaudePlanUsage['rate_limits'] } : null
    } catch (error) {
        logger.warn({ err: (error as Error).message }, 'claude plan usage endpoint unreachable')
        noteDesktopPlanUsage('claude', { outcome: `endpoint-unreachable:${(error as Error).name}` })
        return null
    }
}

/**
 * The endpoint only. The runner started for this alone answers that it has no limits to report
 * (seen with the owner's plan on November 14, 2026), so it is not started when the endpoint refuses.
 */
const readEither = (token: string, _harness: Record<string, string>) => fetchDesktopClaudePlanUsage(token)

let reading: Promise<void> | undefined, attemptedAt = 0

/**
 * Keeps the Claude plan's limits current for the providers list: read when asked, at most every
 * five minutes. A reply still records them itself when it ends.
 */
export function refreshStaleDesktopClaudePlanLimits(connection: LoadedConnection, harness: Record<string, string>, read = readEither, now = Date.now()): Promise<void> {
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
export function resetDesktopClaudePlanLimitPacing() { attemptedAt = 0; refusedUntil = 0 }

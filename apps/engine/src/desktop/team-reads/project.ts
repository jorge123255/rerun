import {
    DESKTOP_TEAM_READ_FIELD_LIMIT,
    DESKTOP_TEAM_READ_RESPONSE_LIMIT,
    DESKTOP_TEAM_READ_RUN_LIMIT_DEFAULT,
    DESKTOP_TEAM_READ_RUN_LIMIT_MAX,
    DESKTOP_TEAM_WAITING_SESSION_STATUSES,
    desktopTeamReadTooLarge,
    type DesktopTeamMemberStatus,
    type DesktopTeamWaitingSessionStatus,
} from '@rerun/contracts'
import type { DesktopTeamActivity, DesktopTeamRunView, DesktopTeamScheduleView, DesktopTeamToolCallView, DesktopTeamTriggerView } from './ports.js'

const WAITING = new Set<string>(DESKTOP_TEAM_WAITING_SESSION_STATUSES)
const SECRET_KEY = /^(url|urls|token|tokens|secret|secrets|password|authorization|api[-_]?key|webhook|webhookurl|webhook_url)$/i
const JSON_CONTAINER = /^\s*(?:\{|\[)/

export function desktopTeamMemberStatus(facts: {
    switchedOff: boolean
    configured: boolean
    reachable: boolean
    runningCount: number
    waitingCount: number
    lastFinishedStatus: string | null
}): DesktopTeamMemberStatus {
    if (facts.switchedOff) return 'switched_off'
    if (!facts.configured) return 'unconfigured'
    if (!facts.reachable) return 'offline'
    if (facts.runningCount > 0) return 'working'
    if (facts.waitingCount > 0) return 'waiting_human'
    if (facts.lastFinishedStatus === 'error') return 'error'
    return 'idle'
}

export function desktopTeamWaitingReason(status: string): DesktopTeamWaitingSessionStatus | null {
    return WAITING.has(status) ? status as DesktopTeamWaitingSessionStatus : null
}

export function desktopTeamAgentIdProblem(value: string): boolean {
    return value.length < 1 || value.length > 128 || value !== value.trim() || value === '.' || value === '..' || /[/\\\0\s]/.test(value)
}

export function desktopTeamRunLimit(value: number | undefined): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) return DESKTOP_TEAM_READ_RUN_LIMIT_DEFAULT
    return Math.min(Math.max(Math.trunc(value), 1), DESKTOP_TEAM_READ_RUN_LIMIT_MAX)
}

/** Same marker the hosted MCP field trim uses, so a model sees one wording for a cut tool result. */
export function desktopTeamTruncateField(value: string | null, limit = DESKTOP_TEAM_READ_FIELD_LIMIT): string | null {
    if (value === null || value.length <= limit || value.includes('… [truncated] ')) return value
    return `${value.slice(0, limit)}… [truncated] ${value.length - limit} more chars elided to save context`
}

function scrubLoose(value: string): string {
    return value
        .replace(/\bBearer[ \t]+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [omitted]')
        .replace(/([?&](?:token|secret|api_key|apikey|password)=)[^&\s"'\\]+/gi, '$1[omitted]')
}

export function desktopTeamScrub(value: unknown): unknown {
    if (typeof value === 'string') {
        // Some tools return serialized JSON inside the stored result. Keep the
        // string envelope while removing secrets from the structure it contains.
        if (JSON_CONTAINER.test(value)) {
            let parsed: unknown
            try { parsed = JSON.parse(value) }
            catch { return scrubLoose(value) }
            return JSON.stringify(desktopTeamScrub(parsed))
        }
        return scrubLoose(value)
    }
    if (Array.isArray(value)) return value.map(item => desktopTeamScrub(item))
    if (!value || typeof value !== 'object') return value
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value)) {
        if (SECRET_KEY.test(key)) continue
        out[key] = desktopTeamScrub(item)
    }
    return out
}

export function desktopTeamPayload(name: string, value: unknown): unknown {
    const scrubbed = desktopTeamScrub(value)
    const serialized = JSON.stringify(scrubbed)
    if (serialized.length > DESKTOP_TEAM_READ_RESPONSE_LIMIT) throw new Error(desktopTeamReadTooLarge(name, serialized.length))
    return scrubbed
}

export function desktopTeamScheduleView(row: {
    slug: string
    name: string
    description?: string
    body?: string
    cron?: string | null
    runAt?: string | null
    timezone?: string | null
    enabled: boolean
    lastRunAt?: string | null
}): DesktopTeamScheduleView {
    return {
        slug: row.slug,
        name: row.name,
        description: row.description ?? '',
        body: row.body ?? '',
        cron: row.cron ?? null,
        runAt: row.runAt ?? null,
        timezone: row.timezone ?? null,
        enabled: row.enabled,
        lastRunAt: row.lastRunAt ?? null,
    }
}

export function desktopTeamTriggerView(row: {
    slug: string
    name: string
    description?: string
    body?: string
    methods: readonly string[]
    enabled: boolean
    fireCount: number
    lastFiredAt: string | null
    token?: string
    url?: string | null
}): DesktopTeamTriggerView {
    const redact = (value: string) => {
        if (row.url) value = value.split(row.url).join('[omitted]')
        if (row.token) value = value.split(row.token).join('[omitted]')
        return value
    }
    return {
        slug: row.slug,
        name: redact(row.name),
        description: redact(row.description ?? ''),
        body: redact(row.body ?? ''),
        methods: [...row.methods],
        enabled: row.enabled,
        fireCount: row.fireCount,
        lastFiredAt: row.lastFiredAt,
    }
}

export function desktopTeamRunView(run: {
    id: string
    status: string
    sessionId: string
    provider: string | null
    model: string | null
    triggerSource: string | null
    triggerSlug: string | null
    stepCount: number
    inputTokens: number | null
    outputTokens: number | null
    totalTokens: number | null
    costMicros: number | null
    startedAt: string
    finishedAt: string | null
    error: string | null
}): DesktopTeamRunView {
    return {
        runId: run.id,
        status: run.status,
        sessionId: run.sessionId,
        provider: run.provider,
        model: run.model,
        trigger: run.triggerSlug ? `${run.triggerSource ?? 'unknown'}:${run.triggerSlug}` : run.triggerSource,
        steps: run.stepCount,
        inputTokens: run.inputTokens,
        outputTokens: run.outputTokens,
        totalTokens: run.totalTokens,
        costUsd: run.costMicros === null ? null : run.costMicros / 1_000_000,
        startedAt: run.startedAt,
        finishedAt: run.finishedAt,
        error: run.error,
    }
}

function scrubToolCallJson(value: string | null): string | null {
    if (typeof value !== 'string') return null
    let parsed: unknown
    try { parsed = JSON.parse(value) }
    catch { return JSON_CONTAINER.test(value) ? null : scrubLoose(value) }
    return JSON.stringify(desktopTeamScrub(parsed))
}

export function desktopTeamToolCallView(call: {
    stepNumber: number
    toolName: string
    inputJson: string | null
    resultJson: string | null
    isError: number | boolean
    durationMs: number | null
}): DesktopTeamToolCallView {
    return {
        step: call.stepNumber,
        tool: call.toolName,
        input: desktopTeamTruncateField(scrubToolCallJson(call.inputJson)),
        result: desktopTeamTruncateField(scrubToolCallJson(call.resultJson)),
        isError: call.isError === true || call.isError === 1,
        durationMs: call.durationMs,
    }
}

export function desktopTeamActivityFrom(
    running: Array<{ id: string; sessionId: string; triggerSource: string | null; triggerSlug: string | null; stepCount: number; startedAt: string }>,
    recent: Array<{ id: string; status: string; finishedAt: string | null; error: string | null }>,
    sessions: Array<{ id: string; status: string }>,
): DesktopTeamActivity {
    const last = recent.find(run => run.status !== 'running') ?? null
    return {
        running: running.map(run => ({
            runId: run.id,
            sessionId: run.sessionId,
            trigger: run.triggerSlug ? `${run.triggerSource ?? 'unknown'}:${run.triggerSlug}` : run.triggerSource,
            startedAt: run.startedAt,
            steps: run.stepCount,
        })),
        waitingOn: sessions.flatMap(session => {
            const reason = desktopTeamWaitingReason(session.status)
            return reason ? [{ sessionId: session.id, reason }] : []
        }),
        lastFinished: last && { runId: last.id, status: last.status, finishedAt: last.finishedAt, error: last.error },
    }
}

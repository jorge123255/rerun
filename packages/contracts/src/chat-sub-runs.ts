import { stripBridgePrefix } from './chat-tool-name.js'

export const SUB_RUN_STALLED_AFTER_MS = 3 * 60_000
export const SUB_RUN_FAILURE_STREAK = 3
export const SUB_RUN_LONG_CALL_MS = 20_000
// The engine sends the last characters of a sub-run's text, not the first: PREVIEW_LENGTH in sub-run-watch.ts.
export const SUB_RUN_PREVIEW_LENGTH = 600

export type SubRunStatus = 'queued' | 'running' | 'done' | 'error' | 'stopped' | 'dispatched'

export type SubRunCall = { tool: string; summary: string; failed?: boolean; durationMs?: number; elapsedMs?: number }

export type SubRunTask = {
    id?: string
    title: string
    status: SubRunStatus
    steps: number
    toolCalls?: number
    failures?: number
    calls?: SubRunCall[]
    activity?: string
    preview?: string
    idleMs?: number
    startedAt?: number
    finishedAt?: number
    error?: string
}

export const currentCall = (task: SubRunTask): SubRunCall | undefined => task.calls?.find(call => call.elapsedMs !== undefined)

export const isSubRunFailing = (task: SubRunTask) => task.status === 'running' && (task.failures ?? 0) >= SUB_RUN_FAILURE_STREAK

export type SubRunProgress = { kind: 'delegate' | 'call-agent'; tasks: SubRunTask[] }

type DelegatePartData = { tasks?: (Omit<SubRunTask, 'title'> & { title?: string })[] }
type CallAgentPartData = Omit<SubRunTask, 'title'> & { agentName?: string }

type PartLike = { type: string; id?: string; data?: unknown; toolName?: string; toolCallId?: string }

export const SUB_RUN_TOOL_NAMES: Record<SubRunProgress['kind'], string> = { delegate: 'delegate_tasks', 'call-agent': 'call_agent' }

export function subRunProgressOf(part: PartLike): SubRunProgress | null {
    if (part.type === 'data-delegate') {
        const data = part.data as DelegatePartData
        return { kind: 'delegate', tasks: (data.tasks ?? []).map((task, i) => ({ ...task, title: task.title || `Sub-coworker ${i + 1}` })) }
    }
    if (part.type === 'data-call-agent') {
        const { agentName, ...task } = part.data as CallAgentPartData
        return { kind: 'call-agent', tasks: [{ ...task, title: agentName || 'Coworker' }] }
    }
    return null
}

const toolNameOf = (part: PartLike) => stripBridgePrefix(part.toolName ?? part.type.replace(/^tool-/, ''))
const isToolPart = (part: PartLike) => part.type.startsWith('tool-') || part.type === 'dynamic-tool'

export type SubRunPairing = {
    byToolCallId: Map<string, SubRunProgress>
    /** Keyed by the data part id: progress no tool row could take, which has to render on its own. */
    orphans: Map<string, SubRunProgress>
}

/**
 * Hands each progress part to the tool row it belongs to. A direct API provider shares the tool call
 * id with the part. A CLI provider (claude, codex) cannot: its MCP bridge gives the tool an id of its
 * own, so what is left after the exact matches is paired by order, kind by kind. The engine emits
 * one part per call, before its first await, which keeps both lists in the same order.
 */
export function pairSubRuns(parts: readonly PartLike[]): SubRunPairing {
    const byToolCallId = new Map<string, SubRunProgress>()
    const orphans = new Map<string, SubRunProgress>()

    const progressById = new Map<string, SubRunProgress>()
    for (const part of parts) {
        const progress = part.id ? subRunProgressOf(part) : null
        if (progress) progressById.set(part.id!, progress)
    }

    const unpairedToolCallIds: Record<SubRunProgress['kind'], string[]> = { delegate: [], 'call-agent': [] }
    for (const part of parts) {
        if (!isToolPart(part) || !part.toolCallId) continue
        const exact = progressById.get(part.toolCallId)
        if (exact) {
            byToolCallId.set(part.toolCallId, exact)
            progressById.delete(part.toolCallId)
            continue
        }
        const toolName = toolNameOf(part)
        if (toolName === SUB_RUN_TOOL_NAMES.delegate) unpairedToolCallIds.delegate.push(part.toolCallId)
        else if (toolName === SUB_RUN_TOOL_NAMES['call-agent']) unpairedToolCallIds['call-agent'].push(part.toolCallId)
    }

    for (const [partId, progress] of progressById) {
        const toolCallId = unpairedToolCallIds[progress.kind].shift()
        if (toolCallId) byToolCallId.set(toolCallId, progress)
        else orphans.set(partId, progress)
    }
    return { byToolCallId, orphans }
}

export const isSubRunLive = (task: SubRunTask) => task.status === 'running' || task.status === 'queued'

export const isSubRunStalled = (task: SubRunTask) => task.status === 'running' && (task.idleMs ?? 0) >= SUB_RUN_STALLED_AFTER_MS

export type SubRunCounts = { total: number; done: number; failed: number; live: number; stalled: number; failing: number }

export function countSubRuns(tasks: readonly SubRunTask[]): SubRunCounts {
    return {
        total: tasks.length,
        done: tasks.filter(t => t.status === 'done').length,
        failed: tasks.filter(t => t.status === 'error' || t.status === 'stopped').length,
        live: tasks.filter(isSubRunLive).length,
        stalled: tasks.filter(isSubRunStalled).length,
        failing: tasks.filter(isSubRunFailing).length,
    }
}

export function subRunTroubleLabel(counts: SubRunCounts): string {
    const stalled = counts.stalled > 0 ? ` · ${counts.stalled} stalled` : ''
    const failing = counts.failing > 0 ? ` · ${counts.failing} failing` : ''
    return `${stalled}${failing}`
}

export function subRunDurationSeconds(tasks: readonly SubRunTask[]): number | undefined {
    const starts = tasks.flatMap(t => (t.startedAt === undefined ? [] : [t.startedAt]))
    const ends = tasks.flatMap(t => (t.finishedAt === undefined ? [] : [t.finishedAt]))
    if (!starts.length || !ends.length) return undefined
    return Math.max(0, (Math.max(...ends) - Math.min(...starts)) / 1000)
}

const HEADING = /^#{1,6}\s/

const plainLine = (line: string) =>
    line
        .replace(/^(#{1,6}|[-*>]|\d+\.)\s+/, '')
        .replace(/\*\*|__|`/g, '')
        .trim()

/** The one line a settled sub-run is summed up by: the first whole sentence of what its preview still holds. */
export function subRunOutcome(preview?: string): string | undefined {
    let text = preview?.trim() ?? ''
    if (preview && preview.length >= SUB_RUN_PREVIEW_LENGTH) {
        const boundary = text.match(/[.!?]\s+|\n/)
        if (boundary?.index !== undefined) text = text.slice(boundary.index + boundary[0].length)
    }
    const lines = text
        .split('\n')
        .map(line => line.trim())
        .filter(Boolean)
    const line = lines.find(candidate => !HEADING.test(candidate)) ?? lines[0]
    if (!line) return undefined
    return plainLine(line).split(/(?<=[.!?])\s/)[0] || undefined
}

/** Seconds as `3.4s` under 10s, `12s` under a minute, `1m 05s` beyond. */
export function formatElapsed(seconds: number): string {
    if (seconds < 10) return `${seconds.toFixed(1)}s`
    if (seconds < 60) return `${Math.floor(seconds)}s`
    const m = Math.floor(seconds / 60)
    const s = Math.floor(seconds % 60)
    return `${m}m ${String(s).padStart(2, '0')}s`
}

const plural = (count: number, word: string) => `${count} ${word}${count > 1 ? 's' : ''}`

const progressLabel = (task: SubRunTask) => (task.toolCalls === undefined ? `Step ${task.steps}` : plural(task.toolCalls, 'call'))

export type SubRunHeadline = { label: string; summary?: string }

// build_team reports on the same block as a delegation: one row per agent of the plan, built rather
// than delegated.
export function subRunHeadline({ kind, tasks }: SubRunProgress, live: boolean, toolName: string): SubRunHeadline {
    const counts = countSubRuns(tasks)
    const trouble = subRunTroubleLabel(counts)
    const seconds = subRunDurationSeconds(tasks)
    const duration = seconds === undefined ? '' : ` · ${formatElapsed(seconds)}`

    if (kind === 'call-agent') {
        const [call] = tasks
        if (call.status === 'stopped') return { label: `${call.title} stopped${duration}` }
        if (call.status === 'dispatched') return { label: `Message sent to ${call.title}` }
        if (live) return { label: `Calling ${call.title}`, summary: `${progressLabel(call)}${trouble}` }
        return { label: call.status === 'error' ? `${call.title} failed${duration}` : `${call.title} answered${duration}` }
    }

    const building = toolName === 'build_team'
    // The onboarding builds one agent: its name is the whole headline, and a count of one says nothing.
    if (building && tasks.length === 1) {
        const [agent] = tasks
        if (live) return { label: `Building ${agent.title}` }
        return { label: counts.failed ? `${agent.title} could not be built${duration}` : `${agent.title} built${duration}` }
    }
    if (live) return { label: building ? `Building your team · ${plural(counts.total, 'coworker')}` : `Delegating · ${plural(counts.total, 'task')}`, summary: `${counts.done + counts.failed}/${counts.total} done${trouble}` }
    if (counts.failed === 0) return building ? { label: `${plural(counts.total, 'coworker')} built${duration}`, summary: 'Open one from the board' } : { label: `${plural(counts.total, 'task')} done${duration}` }
    return { label: `${counts.done} done · ${counts.failed} failed${duration}` }
}

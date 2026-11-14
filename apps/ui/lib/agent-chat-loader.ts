import { stripBridgePrefix } from '@/lib/chat/bridge-name'
import { countSubRuns, isSubRunLive, pairSubRuns, subRunTroubleLabel, type SubRunCounts } from '@/lib/chat/sub-run-progress'

export const loadingLabels = ['Thinking...', 'Processing your request...', 'Crafting a response...']

const HITL_TOOLS = new Set(['ask_user', 'request_approval', 'suggest_service', 'request_secret', 'request_mcp_sign_in', 'request_takeover', 'request_spend'])
const TERMINAL_TOOL_STATES = new Set(['output-available', 'output-error', 'output-denied'])

type PartLike = { type: string; id?: string; state?: string; toolName?: string; toolCallId?: string; input?: unknown; data?: unknown; preliminary?: boolean }
type MessageLike = { role: string; parts: readonly PartLike[] }

const isToolPart = (part: PartLike) => part.type.startsWith('tool-') || part.type === 'dynamic-tool'
const isRunningTool = (part: PartLike) => isToolPart(part) && (part.state === 'output-available' && part.preliminary === true || !TERMINAL_TOOL_STATES.has(part.state ?? ''))

type ActivityKey = 'thinking' | 'writing' | 'runningTool' | 'waitingOn' | 'building' | 'buildingCoworkers' | 'waitingOnSubCoworkers'
type ActivityValues = { name?: string; tool?: string; count?: number; done?: number }
type ActivityCopy = {
    activity: (key: ActivityKey, values?: ActivityValues) => string
    trouble: (counts: SubRunCounts) => string
}

function activitySubRuns(parts: readonly PartLike[]) {
    // Saved or interrupted streams can carry incomplete progress parts.
    return pairSubRuns(parts.filter(part => {
        if (part.type === 'data-call-agent') {
            return isRecord(part.data) && (part.data.agentName == null || typeof part.data.agentName === 'string')
        }
        if (part.type === 'data-delegate') {
            return isRecord(part.data) && Array.isArray(part.data.tasks) && part.data.tasks.every(task =>
                isRecord(task) && (task.title == null || typeof task.title === 'string'))
        }
        return true
    })).byToolCallId
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * True while the message ends on a live step of its step group, which already shows the coworker
 * and what it is doing: the loader under the thread would only repeat it.
 */
export function stepGroupShowsActivity(message: MessageLike | undefined): boolean {
    if (!message || message.role !== 'assistant') return false
    const last = message.parts.findLast(part => !part.type.startsWith('data-'))
    if (!last) return false
    if (last.type === 'reasoning') return last.state === 'streaming'
    if (!isRunningTool(last) || last.state === 'approval-requested') return false
    const toolName = stripBridgePrefix(last.toolName ?? last.type.replace(/^tool-/, ''))
    if (HITL_TOOLS.has(toolName)) return false
    const progress = last.toolCallId ? activitySubRuns(message.parts).get(last.toolCallId) : undefined
    return !progress
}

/**
 * What the run is doing right now, read off the streaming message. Null when the message says nothing
 * yet, which leaves the caller on its generic rotation.
 */
export function liveActivityLabel(message: MessageLike | undefined, toolLabel: (toolName: string, input?: unknown) => string, copy?: ActivityCopy): string | null {
    if (!message || message.role !== 'assistant') return null

    const subRuns = activitySubRuns(message.parts)
    for (const part of message.parts) {
        if (!isRunningTool(part) || !part.toolCallId) continue
        const progress = subRuns.get(part.toolCallId)
        if (!progress || !progress.tasks.some(isSubRunLive)) continue
        const counts = countSubRuns(progress.tasks)
        const trouble = copy ? copy.trouble(counts) : subRunTroubleLabel(counts)
        const name = progress.tasks[0].title
        const values = { count: counts.total, done: counts.done + counts.failed }
        if (progress.kind === 'call-agent') return (copy?.activity('waitingOn', { name }) ?? `Waiting on ${name}`) + trouble
        if (part.type === 'tool-build_team') {
            if (counts.total === 1) return copy?.activity('building', { name }) ?? `Building ${name}`
            return (copy?.activity('buildingCoworkers', values) ?? `Building ${values.count} coworkers · ${values.done} done`) + trouble
        }
        return (copy?.activity('waitingOnSubCoworkers', values) ?? `Waiting on ${values.count} sub-coworker${values.count > 1 ? 's' : ''} · ${values.done} done`) + trouble
    }

    const last = message.parts.findLast(part => !part.type.startsWith('data-'))
    if (!last) return null
    if (isRunningTool(last)) {
        const toolName = stripBridgePrefix(last.toolName ?? last.type.replace(/^tool-/, ''))
        if (HITL_TOOLS.has(toolName) || last.state === 'approval-requested') return null
        const tool = toolLabel(toolName, last.input)
        return copy?.activity('runningTool', { tool }) ?? `Running ${tool}`
    }
    if (last.type === 'reasoning' && last.state === 'streaming') return copy?.activity('thinking') ?? 'Thinking...'
    if (last.type === 'text' && last.state === 'streaming') return copy?.activity('writing') ?? 'Writing...'
    return null
}

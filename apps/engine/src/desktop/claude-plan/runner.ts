import {
    DESKTOP_CLAUDE_PLAN_MAX_HISTORY_EVENTS,
    desktopClaudePlanChatResultSchema,
    desktopClaudePlanOperationId,
    desktopClaudePlanStreamEventSchema,
    type DesktopClaudePlanAuthority,
    type DesktopClaudePlanChatIdentity,
    type DesktopClaudePlanChatInput,
    type DesktopClaudePlanChatResult,
    type DesktopClaudePlanRunner,
    type DesktopClaudePlanChatStore,
    type DesktopClaudePlanStreamEvent,
} from '@rerun/contracts'

export function createDesktopClaudePlanRunner(runner: DesktopClaudePlanRunner, outcomes: DesktopClaudePlanChatStore, authority: DesktopClaudePlanAuthority, options: { now?: () => string } = {}) {
    const now = options.now ?? (() => new Date().toISOString())

    async function dispatch(identity: DesktopClaudePlanChatIdentity, input: DesktopClaudePlanChatInput, signal?: AbortSignal): Promise<DesktopClaudePlanChatResult> {
        const operationId = await desktopClaudePlanOperationId(identity, input)
        const existing = await outcomes.begin(identity, operationId)
        if (existing !== 'execute') return existing
        const createdAt = now()
        const events: DesktopClaudePlanStreamEvent[] = []
        let text = ''
        let finishReason: 'stop' | 'length' | 'tool-calls' | 'error' | 'cancelled' = 'stop'
        let failure: string | undefined
        let started = false
        try {
            if (signal?.aborted) throw new Error('Run cancelled')
            await authority(identity, signal ?? new AbortController().signal)
            started = true
            for await (const event of runner.dispatch(identity, input, signal ?? new AbortController().signal) {
                if (signal?.aborted) throw new Error('Run cancelled')
                const parsed = desktopClaudePlanStreamEventSchema.parse(event)
                if (parsed.type === 'source' && !['http:', 'https:'].includes(new URL(parsed.url).protocol)) throw new Error('Claude source URL is not HTTP(S).')
                events.push(parsed)
                if (events.length > DESKTOP_CLAUDE_PLAN_MAX_HISTORY_EVENTS) throw new Error('Claude stream history exceeded its limit')
                if (parsed.type === 'text-delta') {
                    text += parsed.text
                    if (text.length > 1_000_000) throw new Error('Claude response exceeded its limit')
                } else if (parsed.type === 'error') failure = parsed.message
                else if (parsed.type === 'finish') finishReason = parsed.finishReason
            }
            if (signal?.aborted) throw new Error('Run cancelled')
            await authority(identity, signal ?? new AbortController().signal)
            const result: DesktopClaudePlanChatResult = {
                operationId,
                ...identity,
                status: failure || finishReason === 'error' ? 'error' : 'completed',
                text,
                model: input.model,
                events,
                ...(failure ? { message: failure } : {}),
                createdAt,
                updatedAt: now(),
            }
            await outcomes.complete(result)
            return result
        } catch (error) {
            const cancelled = signal?.aborted || finishReason === 'cancelled'
            const result: DesktopClaudePlanChatResult = {
                operationId,
                ...identity,
                status: cancelled ? 'cancelled' : failure || finishReason === 'error' ? 'error' : started ? 'uncertain' : 'error',
                text,
                model: input.model,
                events,
                message: cancelled ? 'Run cancelled' : error instanceof Error ? error.message.slice(0, 500) : 'Claude stream failed.',
                createdAt,
                updatedAt: now(),
            }
            await runner.stop(identity, signal ?? new AbortController().signal).catch(() => undefined)
            await outcomes.complete(result)
            return result
        }
    }

    return { dispatch, read: outcomes.read, stop: runner.stop }
}

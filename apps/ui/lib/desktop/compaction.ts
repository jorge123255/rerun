import type { CompactionData } from '@/components/chat/CompactionBlock'

/**
 * One compaction row worth drawing: the validated event plus a stable React key.
 * `key` never includes the event payload, so a re-emitted event updates the same row.
 */
export type DesktopCompactionStep = { key: string; data: CompactionData }

const isRecord = (value: unknown): value is Record<string, unknown> =>
    !!value && typeof value === 'object' && !Array.isArray(value)

const metric = (value: unknown): number | undefined =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined

// A message count is a count, not a fraction. Tokens come from an estimate and only need to be finite.
const count = (value: unknown): number | undefined => {
    const valueAsCount = metric(value)
    return valueAsCount !== undefined && Number.isSafeInteger(valueAsCount) ? valueAsCount : undefined
}

/**
 * Validate the data of a live `data-compaction` part. The engine emits only an id, a status and,
 * on success, two metrics. Anything else is dropped rather than printed: a missing metric leaves
 * the settled row without that count instead of showing an invented one. The status is returned
 * as received; an interrupted stream is a projection concern, not a failure this adapter invents.
 */
export function desktopCompactionData(part: unknown): CompactionData | undefined {
    if (!isRecord(part) || part.type !== 'data-compaction' || !isRecord(part.data)) return undefined
    const status = part.data.status
    if (status !== 'running' && status !== 'done' && status !== 'error') return undefined
    const messagesCompacted = count(part.data.messagesCompacted)
    const tokensRecovered = metric(part.data.tokensRecovered)
    return {
        status,
        ...(messagesCompacted !== undefined && { messagesCompacted }),
        ...(tokensRecovered !== undefined && { tokensRecovered }),
    }
}

/**
 * Project the live compaction events onto the rows a reply should draw. The SDK normally folds a
 * re-emitted part with the same id into one, but a replay or a direct stream fixture can carry
 * both events: the last valid event wins, in the position of the first, so a running row settles
 * in place and never duplicates. Parts without an id cannot be proven identical and each stay.
 *
 * A stop or disconnect can lose the final event after the engine already saved a successful
 * checkpoint. An event still at `running` when the reply is no longer live is therefore
 * unconfirmed: it is suppressed rather than shown as complete or failed. Its error wording stays
 * reserved for an error event the engine actually sent.
 */
export function desktopCompactionSteps(parts: readonly unknown[], streaming: boolean): Map<number, DesktopCompactionStep> {
    const steps = new Map<number, DesktopCompactionStep>()
    const firstIndexById = new Map<string, number>()
    parts.forEach((part, index) => {
        const data = desktopCompactionData(part)
        if (!data) return
        const id = isRecord(part) && typeof part.id === 'string' && part.id.length > 0 ? part.id : undefined
        if (!id) {
            steps.set(index, { key: `compaction-${index}`, data })
            return
        }
        const first = firstIndexById.get(id)
        if (first === undefined) {
            firstIndexById.set(id, index)
            steps.set(index, { key: `compaction-${id}`, data })
            return
        }
        steps.set(first, { key: `compaction-${id}`, data })
    })
    if (!streaming) {
        for (const [index, step] of steps) {
            if (step.data.status === 'running') steps.delete(index)
        }
    }
    return steps
}

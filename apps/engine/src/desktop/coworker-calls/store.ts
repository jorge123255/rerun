import { DESKTOP_COWORKER_CALL_INTERRUPTED_REASON, DESKTOP_COWORKER_CALL_MAX_FANOUT, type DesktopCoworkerCallProgress, type DesktopCoworkerCallStatus } from '@rerun/contracts'

export type CoworkerCallPhase = 'reserved' | 'session-open' | 'launched' | 'terminal'

export type CoworkerCallRow = {
    callId: string
    revision: number
    sourceKey: string
    requestFingerprint: string
    parentAgentId: string
    parentSessionId: string
    parentRunId: string
    toolCallId: string
    targetAgentId: string
    targetSessionId: string | null
    targetName: string
    wait: boolean
    status: DesktopCoworkerCallStatus
    phase: CoworkerCallPhase
    launchEpoch: string
    launchClaimed: boolean
    engineParentAgentId: string
    engineParentSessionId: string
    engineParentRunId: string
    engineTargetAgentId: string
    engineTargetSessionId: string | null
    engineChildRunId: string | null
    depth: number
    ancestors: string[]
    progress: DesktopCoworkerCallProgress
    resultText: string | null
    pendingToolCallId: string | null
    error: string | null
    stopRequestId: string | null
    createdAt: string
    updatedAt: string
}

export type CoworkerCallPatch = Partial<Pick<CoworkerCallRow,
    'targetSessionId' | 'status' | 'phase' | 'engineTargetSessionId' | 'engineChildRunId' | 'progress' | 'resultText' | 'pendingToolCallId' | 'error' | 'stopRequestId' | 'launchClaimed'>>

export type CoworkerCallExpect = {
    revision?: number
    statuses?: readonly DesktopCoworkerCallStatus[]
    engineChildRunId?: string | null
    stopUnclaimed?: boolean
}

export interface CoworkerCallStore {
    adoptEpoch(epoch: string, now: string): Promise<void>
    getBySource(sourceKey: string): Promise<CoworkerCallRow | null>
    get(callId: string): Promise<CoworkerCallRow | null>
    listByParentSession(parentSessionId: string): Promise<CoworkerCallRow[]>
    inbound(engineRunId: string): Promise<CoworkerCallRow | null>
    /**
     * `exists`: this source identity already has a row (a retried tool call or a lost acknowledgement).
     * `duplicate`: the same caller conversation already sent this exact request to this coworker and
     * it was delivered (see `repeatsCoworkerCall`); `row` is that earlier call. `fanout`: over the limit.
     */
    insertReserved(row: CoworkerCallRow): Promise<{ inserted: true; row: CoworkerCallRow } | { inserted: false; reason: 'exists' | 'fanout' | 'duplicate'; row: CoworkerCallRow | null }>
    claim(callId: string, epoch: string, now: string): Promise<CoworkerCallRow | null>
    patch(callId: string, expect: CoworkerCallExpect, patch: CoworkerCallPatch, now: string): Promise<CoworkerCallRow | null>
}

const ACTIVE: readonly DesktopCoworkerCallStatus[] = ['queued', 'running', 'dispatched', 'waiting-human']

/**
 * A new tool call that repeats an earlier one: the same caller in the same conversation sends the
 * same request (agent name, message, context, wait) to the same coworker again, typically after
 * a timeout. It is the earlier call, not a second assignment, while that call is still in hand,
 * or when it already finished or waits on the person within the same run. A call that failed,
 * was stopped or never got past its reservation never blocks a new send.
 */
export function repeatsCoworkerCall(earlier: CoworkerCallRow, next: CoworkerCallRow): boolean {
    if (earlier.sourceKey === next.sourceKey || earlier.phase === 'reserved') return false
    if (earlier.parentAgentId !== next.parentAgentId || earlier.parentSessionId !== next.parentSessionId || earlier.engineParentAgentId !== next.engineParentAgentId
        || earlier.targetAgentId !== next.targetAgentId || earlier.requestFingerprint !== next.requestFingerprint) return false
    if (ACTIVE.includes(earlier.status) && earlier.phase !== 'terminal') return true
    return earlier.engineParentRunId === next.engineParentRunId && (earlier.status === 'completed' || earlier.status === 'waiting-human')
}

function clone(row: CoworkerCallRow): CoworkerCallRow {
    return { ...row, ancestors: [...row.ancestors], progress: { ...row.progress, calls: row.progress.calls.map(call => ({ ...call })) } }
}

export function createMemoryCoworkerCallStore(): CoworkerCallStore & { rows(): CoworkerCallRow[] } {
    const rows = new Map<string, CoworkerCallRow>()
    let epoch = ''
    let chain: Promise<unknown> = Promise.resolve()
    const run = <T>(work: () => T | Promise<T>): Promise<T> => {
        const next = chain.then(work, work)
        chain = next.then(() => undefined, () => undefined)
        return next
    }
    return {
        rows: () => [...rows.values()].map(clone),
        adoptEpoch: (next, now) => run(() => {
            if (epoch && epoch !== next) {
                for (const row of rows.values()) {
                    if (!ACTIVE.includes(row.status) || row.phase === 'terminal' || row.launchEpoch === next) continue
                    row.status = 'interrupted'
                    row.phase = 'terminal'
                    row.revision += 1
                    row.error = DESKTOP_COWORKER_CALL_INTERRUPTED_REASON
                    row.updatedAt = now
                }
            }
            epoch = next
        }),
        getBySource: sourceKey => run(() => {
            const row = [...rows.values()].find(item => item.sourceKey === sourceKey)
            return row ? clone(row) : null
        }),
        get: callId => run(() => {
            const row = rows.get(callId)
            return row ? clone(row) : null
        }),
        listByParentSession: parentSessionId => run(() => [...rows.values()]
            .filter(row => row.parentSessionId === parentSessionId)
            .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.callId.localeCompare(b.callId))
            .map(clone)),
        inbound: engineRunId => run(() => {
            const row = [...rows.values()].find(item => item.engineChildRunId === engineRunId)
            return row ? clone(row) : null
        }),
        insertReserved: row => run(() => {
            const existing = [...rows.values()].find(item => item.sourceKey === row.sourceKey)
            if (existing && existing.requestFingerprint !== row.requestFingerprint) throw new Error('Coworker call request changed')
            if (existing) return { inserted: false as const, reason: 'exists' as const, row: clone(existing) }
            const repeated = [...rows.values()].filter(item => repeatsCoworkerCall(item, row)).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]
            if (repeated) return { inserted: false as const, reason: 'duplicate' as const, row: clone(repeated) }
            const sameRun = [...rows.values()].filter(item => item.engineParentRunId === row.engineParentRunId)
            if (sameRun.length >= DESKTOP_COWORKER_CALL_MAX_FANOUT) return { inserted: false as const, reason: 'fanout' as const, row: null }
            const stored = clone(row)
            const sibling = sameRun[0]
            if (sibling) stored.parentRunId = sibling.parentRunId
            rows.set(stored.callId, stored)
            return { inserted: true as const, row: clone(stored) }
        }),
        claim: (callId, nextEpoch, now) => run(() => {
            const row = rows.get(callId)
            if (!row || row.launchClaimed || row.phase !== 'reserved' || row.status !== 'queued' || row.launchEpoch !== nextEpoch) return null
            row.launchClaimed = true
            row.updatedAt = now
            return clone(row)
        }),
        patch: (callId, expect, patch, now) => run(() => {
            const row = rows.get(callId)
            if (!row) return null
            if (expect.revision !== undefined && row.revision !== expect.revision) return null
            if (expect.statuses && !expect.statuses.includes(row.status)) return null
            if (expect.engineChildRunId !== undefined && row.engineChildRunId !== expect.engineChildRunId) return null
            if (expect.stopUnclaimed && row.stopRequestId) return null
            const statusChanged = patch.status !== undefined && patch.status !== row.status
            Object.assign(row, patch, { progress: patch.progress ?? row.progress, ancestors: row.ancestors })
            if (patch.progress) row.progress = { ...patch.progress, calls: patch.progress.calls.map(call => ({ ...call })) }
            if (statusChanged) row.revision += 1
            row.updatedAt = now
            return clone(row)
        }),
    }
}

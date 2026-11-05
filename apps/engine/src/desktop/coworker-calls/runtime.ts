import {
    DESKTOP_COWORKER_CALL_INTERRUPTED_REASON,
    DESKTOP_COWORKER_CALL_MAX_DEPTH,
    DESKTOP_COWORKER_CALL_PREVIEW_CHARS,
    DESKTOP_COWORKER_CALL_RECENT_CALLS,
    DESKTOP_COWORKER_CALL_RESULT_MAX_CHARS,
    desktopCoworkerCallDepthError,
    desktopCoworkerCallFanoutError,
    desktopCoworkerCallResultLimitError,
    desktopCoworkerCallSnapshotOf,
    type DesktopCoworkerCallProgress,
    type DesktopCoworkerCallSnapshot,
    type DesktopCoworkerCallStatus,
} from '@rerun/contracts'
import { followSubRun, renderSubRunOutcome, type SubRunOutcome, type SubRunProgress } from '../../tools/builtin/sub-run-watch.js'
import {
    desktopCoworkerCallPrompt,
    desktopCoworkerCallFingerprint,
    desktopCoworkerCallSourceKey,
    desktopCoworkerCallTitle,
    redactCoworkerCallText,
    resolveDesktopCoworkerCallTarget,
    type DesktopCoworkerCallChoice,
} from './prepare.js'
import { type CoworkerCallRow, type CoworkerCallStore } from './store.js'

const ACTIVE: readonly DesktopCoworkerCallStatus[] = ['queued', 'running', 'dispatched', 'waiting-human']
const ATTENTION_TOOLS = new Set(['ask_user', 'request_approval', 'request_takeover'])
const EMPTY_PROGRESS: DesktopCoworkerCallProgress = { steps: 0, toolCalls: 0, failures: 0, preview: '', calls: [] }

export type CoworkerCallAuthorization = {
    publicAgentId: string
    publicSessionId: string
    name: string
    targets: readonly DesktopCoworkerCallChoice[]
}

export type ChildFollow = {
    runId: string
    result: { fullStream: AsyncIterable<unknown> }
    settled?: Promise<unknown>
}

export type CoworkerCallTargetAdmission = {
    caller: { engineAgentId: string; engineSessionId: string; engineRunId: string }
    target: { publicAgentId: string; engineAgentId: string }
}

export type PreparedCoworkerCallTarget = CoworkerCallTargetAdmission['target'] & {
    connectionId: string
    model: string
}

export type DesktopCoworkerCallDeps = {
    epoch: string
    now: () => string
    newCallId: () => string
    newPublicRunId: () => string
    store: CoworkerCallStore
    authorize: (input: { engineAgentId: string; engineSessionId: string; engineRunId: string }) => Promise<{ ok: true; caller: CoworkerCallAuthorization } | { ok: false; reason: string }>
    prepareTarget: (input: CoworkerCallTargetAdmission) => Promise<PreparedCoworkerCallTarget>
    createEngineSession: (input: { engineTargetAgentId: string; title: string; originAgentId: string; originSessionId: string }) => Promise<{ engineSessionId: string }>
    adoptPublicSession: (input: { publicAgentId: string; engineSessionId: string; title: string }) => Promise<{ publicSessionId: string }>
    notifyOpened: (input: { engineTargetAgentId: string; engineSessionId: string; title: string; callerName: string; originAgentId: string }) => Promise<void>
    notifyFailed: (input: { engineTargetAgentId: string; engineSessionId: string; reason: string }) => Promise<void>
    startChildRun: (input: { engineTargetAgentId: string; engineSessionId: string; prompt: string; model: PreparedCoworkerCallTarget; assertActive: () => Promise<void>; onRunCreated: (runId: string) => Promise<void> }) => Promise<{ engineRunId: string; follow: ChildFollow }>
    cancelChildRun: (input: { engineTargetAgentId: string; engineRunId: string }) => Promise<void>
}

export type ExecuteCoworkerCall = {
    engineAgentId: string
    engineSessionId: string
    engineRunId: string
    toolCallId: string
    callerName: string
    agentRef: string
    message: string
    context?: string
    wait?: boolean
    parentSignal?: AbortSignal
    onProgress: (snapshot: DesktopCoworkerCallSnapshot) => void
}

export type DesktopCoworkerCallRuntime = {
    execute: (input: ExecuteCoworkerCall) => Promise<{ text: string; snapshot: DesktopCoworkerCallSnapshot | null }>
}

function snapshotOf(row: CoworkerCallRow): DesktopCoworkerCallSnapshot {
    return desktopCoworkerCallSnapshotOf({
        callId: row.callId,
        revision: row.revision,
        parentAgentId: row.parentAgentId,
        parentSessionId: row.parentSessionId,
        parentRunId: row.parentRunId,
        toolCallId: row.toolCallId,
        targetAgentId: row.targetAgentId,
        targetSessionId: row.targetSessionId,
        targetName: row.targetName,
        wait: row.wait,
        status: row.status,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        progress: row.progress,
    })
}

function project(progress: SubRunProgress, closing?: 'cancelled'): DesktopCoworkerCallProgress {
    const calls = progress.calls.slice(-DESKTOP_COWORKER_CALL_RECENT_CALLS).map(call => ({
        tool: (call.tool || 'tool').slice(0, 120),
        status: call.endedAt === undefined ? (closing === 'cancelled' ? 'cancelled' as const : 'running' as const) : call.failed ? 'error' as const : 'completed' as const,
    }))
    return {
        steps: progress.steps,
        toolCalls: progress.toolCalls,
        failures: progress.failures,
        preview: redactCoworkerCallText(progress.preview ?? '').slice(-DESKTOP_COWORKER_CALL_PREVIEW_CHARS),
        calls,
    }
}

function liveStatus(progress: SubRunProgress, wait: boolean): DesktopCoworkerCallStatus {
    const waiting = progress.calls.some(call => call.endedAt === undefined && ATTENTION_TOOLS.has(call.tool))
    if (waiting) return 'waiting-human'
    return wait ? 'running' : 'dispatched'
}

function boundedCallerText(name: string, text: string): string {
    const redacted = redactCoworkerCallText(text)
    if (redacted.length > DESKTOP_COWORKER_CALL_RESULT_MAX_CHARS) return desktopCoworkerCallResultLimitError(name)
    return redacted
}

// Original call-agent.ts returns renderSubRunOutcome for a stop. The whole string is refused when it exceeds the named limit.
function answerFor(name: string, outcome: SubRunOutcome, progress: SubRunProgress): string {
    if (outcome.stopReason === undefined) return boundedCallerText(name, outcome.text) || '(the coworker returned no text)'
    return boundedCallerText(name, `(error calling ${name}: ${renderSubRunOutcome(outcome, progress)})`)
}

export function createDesktopCoworkerCallRuntime(deps: DesktopCoworkerCallDeps): DesktopCoworkerCallRuntime {
    const inflight = new Map<string, { fingerprint: string; work: Promise<{ text: string; snapshot: DesktopCoworkerCallSnapshot | null }> }>()
    const changedRequest = () => ({ text: 'This coworker call already belongs to a different request. Start a new call.', snapshot: null })

    const publish = async (row: CoworkerCallRow, onProgress: (snapshot: DesktopCoworkerCallSnapshot) => void) => {
        const snapshot = snapshotOf(row)
        try { onProgress(snapshot) } catch { /* The durable row outlives the caller's closed stream. */ }
        return snapshot
    }

    const fail = async (callId: string, engineChildRunId: string | null, reason: string, onProgress: ExecuteCoworkerCall['onProgress']) => {
        // A claimed Stop owns the row. A launch failure must not replace that Stop with a later error.
        const row = await deps.store.patch(callId, { statuses: ACTIVE, stopUnclaimed: true, ...(engineChildRunId ? { engineChildRunId } : {}) }, {
            status: 'error', phase: 'terminal', error: reason, resultText: reason,
        }, deps.now())
        if (row) await publish(row, onProgress)
        return row
    }

    const executeOnce = async (input: ExecuteCoworkerCall): Promise<{ text: string; snapshot: DesktopCoworkerCallSnapshot | null }> => {
        const sourceKey = desktopCoworkerCallSourceKey(input)
        const existing = await deps.store.getBySource(sourceKey)
        if (existing) {
            if (existing.requestFingerprint !== desktopCoworkerCallFingerprint(input)) return changedRequest()
            if (existing.phase === 'terminal' && existing.status !== 'interrupted') {
                return { text: existing.resultText ?? `Call to ${existing.targetName} has finished.`, snapshot: await publish(existing, input.onProgress) }
            }
            if (existing.launchEpoch !== deps.epoch || existing.status === 'interrupted') {
                const settled = existing.status === 'interrupted' ? existing : await deps.store.patch(existing.callId, { statuses: ACTIVE }, {
                    status: 'interrupted', phase: 'terminal', error: DESKTOP_COWORKER_CALL_INTERRUPTED_REASON,
                }, deps.now())
                const row = settled ?? existing
                return { text: row.resultText ?? DESKTOP_COWORKER_CALL_INTERRUPTED_REASON, snapshot: await publish(row, input.onProgress) }
            }
            if (existing.phase !== 'reserved' || existing.launchClaimed || existing.status !== 'queued') {
                return { text: existing.resultText ?? `Call to ${existing.targetName} is already running.`, snapshot: await publish(existing, input.onProgress) }
            }
        }

        const auth = await deps.authorize(input)
        if (!auth.ok) {
            if (!existing) return { text: auth.reason, snapshot: null }
            const failed = await fail(existing.callId, null, auth.reason, input.onProgress)
            return { text: auth.reason, snapshot: failed ? snapshotOf(failed) : null }
        }
        const prior = await deps.store.inbound(input.engineRunId)
        const depth = prior ? prior.depth + 1 : 0
        const ancestors = prior ? [...prior.ancestors, auth.caller.publicAgentId] : [auth.caller.publicAgentId]
        if (!existing && depth >= DESKTOP_COWORKER_CALL_MAX_DEPTH) return { text: desktopCoworkerCallDepthError(), snapshot: null }
        const resolved = existing
            ? { target: { publicAgentId: existing.targetAgentId, engineAgentId: existing.engineTargetAgentId, name: existing.targetName, enabled: true, callable: true } }
            : resolveDesktopCoworkerCallTarget(input.agentRef, auth.caller.targets)
        if ('error' in resolved) return { text: resolved.error, snapshot: null }
        const target = resolved.target
        if (!existing && !target.enabled) return { text: `Coworker "${target.name}" is switched off and cannot be called.`, snapshot: null }
        if (!existing && (!target.callable || target.publicAgentId === auth.caller.publicAgentId || ancestors.includes(target.publicAgentId))) {
            const loop = target.publicAgentId === auth.caller.publicAgentId || ancestors.includes(target.publicAgentId)
            return { text: loop ? `Coworker calls cannot loop back to ${target.name}.` : `Coworker "${target.name}" is not allowed for this coworker.`, snapshot: null }
        }

        const now = deps.now()
        const reserved = existing ?? {
            callId: deps.newCallId(),
            revision: 1,
            sourceKey,
            requestFingerprint: desktopCoworkerCallFingerprint(input),
            parentAgentId: auth.caller.publicAgentId,
            parentSessionId: auth.caller.publicSessionId,
            parentRunId: deps.newPublicRunId(),
            toolCallId: input.toolCallId,
            targetAgentId: target.publicAgentId,
            targetSessionId: null,
            targetName: target.name,
            wait: input.wait === true,
            status: 'queued' as const,
            phase: 'reserved' as const,
            launchEpoch: deps.epoch,
            launchClaimed: false,
            engineParentAgentId: input.engineAgentId,
            engineParentSessionId: input.engineSessionId,
            engineParentRunId: input.engineRunId,
            engineTargetAgentId: target.engineAgentId,
            engineTargetSessionId: null,
            engineChildRunId: null,
            depth,
            ancestors,
            progress: EMPTY_PROGRESS,
            resultText: null,
            pendingToolCallId: null,
            error: null,
            stopRequestId: null,
            createdAt: now,
            updatedAt: now,
        }
        let row = existing
        if (!row) {
            const inserted = await deps.store.insertReserved(reserved)
            if (!inserted.inserted) {
                if (inserted.reason === 'fanout') return { text: desktopCoworkerCallFanoutError(), snapshot: null }
                row = inserted.row
                if (!row) return { text: desktopCoworkerCallFanoutError(), snapshot: null }
                if (row.requestFingerprint !== reserved.requestFingerprint) return changedRequest()
                return { text: row.resultText ?? `Call to ${row.targetName} is already running.`, snapshot: await publish(row, input.onProgress) }
            }
            row = inserted.row
        }
        await publish(row, input.onProgress)
        const claimed = await deps.store.claim(row.callId, deps.epoch, deps.now())
        if (!claimed) {
            const current = await deps.store.get(row.callId)
            return { text: current?.resultText ?? `Call to ${row.targetName} is already running.`, snapshot: current ? await publish(current, input.onProgress) : null }
        }

        const currentRow = row
        let model: PreparedCoworkerCallTarget | undefined
        let engineSessionId = ''
        let savedChildId: string | null = null
        const currentOwned = async () => {
            const current = await deps.store.get(currentRow.callId)
            if (!current || current.sourceKey !== currentRow.sourceKey || current.launchEpoch !== deps.epoch ||
                current.engineTargetAgentId !== currentRow.engineTargetAgentId || current.targetAgentId !== currentRow.targetAgentId) throw new Error('Coworker call identity changed')
            return current
        }
        const assertActive = async () => {
            input.parentSignal?.throwIfAborted()
            const before = await currentOwned()
            if (before.stopRequestId || !ACTIVE.includes(before.status)) throw new Error('stopped by the user')
            const auth = await deps.authorize(input)
            const allowed = auth.ok && auth.caller.publicAgentId === currentRow.parentAgentId && auth.caller.publicSessionId === currentRow.parentSessionId &&
                auth.caller.targets.some(item => item.publicAgentId === target.publicAgentId && item.engineAgentId === target.engineAgentId && item.enabled && item.callable)
            if (!allowed) throw new Error(!auth.ok ? auth.reason : `Coworker "${target.name}" is not allowed for this coworker.`)
            const prepared = await deps.prepareTarget({
                caller: { engineAgentId: input.engineAgentId, engineSessionId: input.engineSessionId, engineRunId: input.engineRunId },
                target: { publicAgentId: target.publicAgentId, engineAgentId: target.engineAgentId },
            })
            if (prepared.publicAgentId !== target.publicAgentId || prepared.engineAgentId !== target.engineAgentId || !prepared.connectionId || !prepared.model) throw new Error('Coworker identity or model could not be confirmed')
            if (model && (model.connectionId !== prepared.connectionId || model.model !== prepared.model)) throw new Error('The coworker model changed before this call started. Start a new call.')
            model = prepared
            const after = await currentOwned()
            if (after.stopRequestId || !ACTIVE.includes(after.status)) throw new Error('stopped by the user')
            input.parentSignal?.throwIfAborted()
        }
        const failAndStop = async (error: unknown) => {
            const reason = error instanceof Error ? error.message : String(error)
            if (savedChildId) {
                try { await deps.cancelChildRun({ engineTargetAgentId: target.engineAgentId, engineRunId: savedChildId }) }
                catch {
                    const latest = await currentOwned().catch(() => null)
                    return { text: `The call to ${target.name} has not finished stopping. Use Stop in its chat and try again.`, snapshot: latest ? await publish(latest, input.onProgress) : null }
                }
            }
            const latest = await currentOwned().catch(() => null)
            let failed: CoworkerCallRow | null = null
            if (latest && ACTIVE.includes(latest.status)) {
                const cancelled = !!latest.stopRequestId || input.parentSignal?.aborted === true || reason === 'stopped by the user'
                failed = await deps.store.patch(currentRow.callId, { statuses: ACTIVE, engineChildRunId: latest.engineChildRunId }, {
                    status: cancelled ? 'cancelled' : 'error', phase: 'terminal', error: reason,
                    resultText: boundedCallerText(target.name, `(error calling ${target.name}: ${reason})`),
                    ...(savedChildId ? { engineChildRunId: savedChildId } : {}),
                }, deps.now()).catch(() => null)
            }
            if (engineSessionId && reason !== 'stopped by the user') await deps.notifyFailed({ engineTargetAgentId: target.engineAgentId, engineSessionId, reason }).catch(() => undefined)
            const final = failed ?? latest
            return { text: boundedCallerText(target.name, `(error calling ${target.name}: ${reason})`), snapshot: final ? await publish(final, input.onProgress) : null }
        }
        try {
            await assertActive()
            const prompt = desktopCoworkerCallPrompt(input.message, input.context)
            const title = desktopCoworkerCallTitle(input.callerName, input.message)
            const session = await deps.createEngineSession({
                engineTargetAgentId: target.engineAgentId, title, originAgentId: input.engineAgentId, originSessionId: input.engineSessionId,
            })
            engineSessionId = session.engineSessionId
            const opened = await deps.store.patch(currentRow.callId, { statuses: ['queued'], engineChildRunId: null, stopUnclaimed: true }, {
                phase: 'session-open', engineTargetSessionId: session.engineSessionId,
            }, deps.now())
            if (!opened) throw new Error('The coworker call changed before its session was saved.')
            const adopted = await deps.adoptPublicSession({ publicAgentId: target.publicAgentId, engineSessionId: session.engineSessionId, title })
            const linked = await deps.store.patch(currentRow.callId, { statuses: ['queued'], stopUnclaimed: true }, { targetSessionId: adopted.publicSessionId }, deps.now())
            if (!linked) throw new Error('The coworker call changed before its chat was saved.')
            await publish(linked, input.onProgress)
            await deps.notifyOpened({ engineTargetAgentId: target.engineAgentId, engineSessionId: session.engineSessionId, title, callerName: input.callerName, originAgentId: input.engineAgentId })
            const child = await deps.startChildRun({
                engineTargetAgentId: target.engineAgentId, engineSessionId: session.engineSessionId, prompt, model: model!, assertActive,
                onRunCreated: async runId => {
                    if (savedChildId && savedChildId !== runId) throw new Error('Coworker run identity changed')
                    savedChildId = runId
                    const bound = await deps.store.patch(currentRow.callId, { statuses: ['queued'], engineChildRunId: null }, { engineChildRunId: runId }, deps.now())
                    if (!bound || bound.stopRequestId) throw new Error('The coworker call was stopped before its run started.')
                },
            })
            if (child.engineRunId !== savedChildId) {
                await deps.cancelChildRun({ engineTargetAgentId: target.engineAgentId, engineRunId: child.engineRunId })
                throw new Error('The coworker run was not saved before it started')
            }
            const launched = await deps.store.patch(currentRow.callId, { statuses: ['queued'], engineChildRunId: child.engineRunId, stopUnclaimed: true }, {
                phase: 'launched', status: currentRow.wait ? 'running' : 'dispatched',
            }, deps.now())
            if (!launched) throw new Error('The coworker call changed before its run was saved.')
            await publish(launched, input.onProgress)
            const progress: SubRunProgress = { status: 'running', steps: 0, toolCalls: 0, failures: 0, calls: [] }
            const progressAbort = new AbortController()
            let progressError: unknown
            let progressWrites = Promise.resolve()
            const flush = () => {
                const patch = { status: liveStatus(progress, currentRow.wait), progress: project(progress) }
                progressWrites = progressWrites.then(async () => {
                    if (progressError) return
                    const next = await deps.store.patch(currentRow.callId, { statuses: ACTIVE, engineChildRunId: child.engineRunId, stopUnclaimed: true }, patch, deps.now())
                    if (next) await publish(next, input.onProgress)
                }).catch(error => { progressError = error; progressAbort.abort() })
            }
            const finish = async (outcome: SubRunOutcome) => {
                await progressWrites
                if (progressError) throw progressError
                const settlement = await child.follow.settled
                const settledKind = settlement && typeof settlement === 'object' && 'kind' in settlement ? settlement.kind : undefined
                if (outcome.stopReason === undefined && settledKind === 'cancelled') outcome = { ...outcome, stopReason: 'stopped by the user' }
                if (outcome.stopReason === undefined && settledKind === 'error') {
                    const reason = settlement && typeof settlement === 'object' && 'error' in settlement && typeof settlement.error === 'string' ? settlement.error : 'The coworker run failed.'
                    outcome = { ...outcome, stopReason: reason }
                }
                const pendingToolCallId = outcome.stopReason === undefined && settledKind === 'done' && settlement && typeof settlement === 'object' &&
                    'pendingToolCallId' in settlement && typeof settlement.pendingToolCallId === 'string' ? settlement.pendingToolCallId : null
                const cancelled = outcome.stopReason === 'stopped by the user' || outcome.stopReason === 'stopped along with the calling run'
                const text = answerFor(target.name, outcome, progress)
                const overlong = !cancelled && text === desktopCoworkerCallResultLimitError(target.name)
                const done = await deps.store.patch(currentRow.callId, { statuses: ACTIVE, engineChildRunId: child.engineRunId }, {
                    status: cancelled ? 'cancelled' : outcome.stopReason !== undefined || overlong ? 'error' : pendingToolCallId ? 'waiting-human' : 'completed', phase: 'terminal',
                    progress: project(progress, cancelled ? 'cancelled' : undefined), error: outcome.stopReason ?? (overlong ? text : null),
                    pendingToolCallId,
                    ...(currentRow.wait ? { resultText: text } : {}),
                }, deps.now())
                const final = done ?? await currentOwned()
                return { text: currentRow.wait ? final.resultText ?? text : text, snapshot: await publish(final, input.onProgress) }
            }
            if (!currentRow.wait) {
                const text = `Message dispatched to ${target.name}. It is handling it in its own session; you will not receive the answer here.`
                const noted = await deps.store.patch(currentRow.callId, { engineChildRunId: child.engineRunId, stopUnclaimed: true }, { resultText: text }, deps.now())
                if (!noted) throw new Error('The coworker call changed before dispatch was confirmed.')
                await publish(noted, input.onProgress)
                void followSubRun(child.follow, progress, { onChange: flush, taskSignal: progressAbort.signal }).then(finish).catch(failAndStop).catch(() => undefined)
                return { text, snapshot: snapshotOf(noted) }
            }
            const outcome = await followSubRun(child.follow, progress, { onChange: flush, parentSignal: input.parentSignal, taskSignal: progressAbort.signal })
            return await finish(outcome)
        } catch (error) {
            return failAndStop(error)
        }
    }

    return {
        execute: input => {
            const key = desktopCoworkerCallSourceKey(input)
            const pending = inflight.get(key)
            const fingerprint = desktopCoworkerCallFingerprint(input)
            if (pending) return pending.fingerprint === fingerprint ? pending.work : Promise.resolve(changedRequest())
            const work = executeOnce(input).finally(() => { if (inflight.get(key)?.work === work) inflight.delete(key) })
            inflight.set(key, { fingerprint, work })
            return work
        },
    }
}

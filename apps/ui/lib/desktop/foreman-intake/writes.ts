'use client'

import {
    desktopForemanIntakeCompletionReceiptSchema,
    desktopForemanIntakeViewSchema,
    toIntake,
    type DesktopForemanChatRef,
    type DesktopForemanIntakeCompleteInput,
    type DesktopForemanIntakeCompletionReceipt,
    type DesktopForemanIntakeSaveInput,
    type DesktopForemanIntakeView,
} from '@rerun/contracts'
import { holdDraftAdmission, isDesktopQuitting } from '@/lib/desktop/draft-writes'
import { hydrateDesktopIntakeMachine, initialDesktopIntakeMachine, type DesktopIntakeMachineState } from './machine'
import { DesktopForemanIntakeClientConflictError, type DesktopForemanIntakeClientPorts } from './ports'

type Intent = { id: number; input: string }
export type IntakeSnapshot = {
    machine: DesktopIntakeMachineState
    restored: boolean
    saving: boolean
    saveFailed: boolean
    conflicted: boolean
    completion: DesktopForemanIntakeCompletionReceipt | null
    /** No receipt was received; the immutable completion attempt still owns its answers. */
    completionUncertain: boolean
    intent: Intent | null
}
export type IntakeRecord = {
    chat: DesktopForemanChatRef
    ports: DesktopForemanIntakeClientPorts
    snapshot: IntakeSnapshot
    listeners: Set<() => void>
    version: number
    savedRevision: number
    dirty: boolean
    attempt?: { input: DesktopForemanIntakeSaveInput; version: number }
    completionAttempt?: DesktopForemanIntakeCompleteInput
    work?: Promise<boolean>
    submitWork?: Promise<void>
    read?: { epoch: number; controller: AbortController; work: Promise<void> }
    readEpoch: number
}

// One intake draft writer per exact chat, retained through close/remount and lost ACKs.
// This never owns a conversation, session, viewer, lease, or model.
const records = new Map<string, IntakeRecord>()
const sameChat = (a: DesktopForemanChatRef, b: DesktopForemanChatRef) => a.workspaceId === b.workspaceId && a.chatId === b.chatId
const messageOf = (error: unknown, fallback: string) => error instanceof Error ? error.message : fallback
const sameAnswers = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

export function intakeRecord(chat: DesktopForemanChatRef, ports: DesktopForemanIntakeClientPorts): IntakeRecord {
    const key = JSON.stringify([chat.workspaceId, chat.chatId])
    let record = records.get(key)
    if (!record) {
        record = {
            chat: { ...chat }, ports, listeners: new Set(), version: 0, savedRevision: 0, dirty: false, readEpoch: 0,
            snapshot: { machine: initialDesktopIntakeMachine(), restored: false, saving: false, saveFailed: false, conflicted: false, completion: null, completionUncertain: false, intent: null },
        }
        records.set(key, record)
    }
    return record
}

export function publishIntake(record: IntakeRecord, patch: Partial<IntakeSnapshot>) {
    record.snapshot = { ...record.snapshot, ...patch }
    for (const listener of record.listeners) listener()
}
const patchMachine = (record: IntakeRecord, patch: Partial<DesktopIntakeMachineState>) => publishIntake(record, { machine: { ...record.snapshot.machine, ...patch } })
export function intakeLocked(record: IntakeRecord) {
    return record.snapshot.completionUncertain || ['pending', 'uncertain', 'failed', 'acknowledged'].includes(record.snapshot.completion?.state ?? '')
}
export function mayEditIntake(record: IntakeRecord) {
    return record.snapshot.restored && !record.snapshot.machine.submitting && !intakeLocked(record) && !isDesktopQuitting()
}

function parseView(record: IntakeRecord, raw: DesktopForemanIntakeView) {
    const view = desktopForemanIntakeViewSchema.parse(raw)
    if (!sameChat(view.session.chat, record.chat) || view.completion && !sameChat(view.completion.chat, record.chat)) throw new Error('Foreman returned answers for another conversation.')
    return view
}
function parseReceipt(record: IntakeRecord, raw: DesktopForemanIntakeCompletionReceipt, input: DesktopForemanIntakeCompleteInput) {
    const receipt = desktopForemanIntakeCompletionReceiptSchema.parse(raw)
    if (!sameChat(receipt.chat, record.chat) || receipt.requestId !== input.requestId || !sameAnswers(receipt.answers, input.answers)) throw new Error('Foreman did not confirm this intake submission.')
    return receipt
}

export function restoreIntake(record: IntakeRecord, discardLocal = false): Promise<void> {
    if (isDesktopQuitting()) return Promise.resolve()
    if (record.read && !record.read.controller.signal.aborted) return record.read.work
    // A reopen cannot erase unsaved answers or forget an admitted operation.
    if (!discardLocal && (record.dirty || record.attempt || record.completionAttempt)) return Promise.resolve()
    if (discardLocal && (record.work || record.submitWork || intakeLocked(record))) return Promise.resolve()
    if (discardLocal) { record.dirty = false; record.attempt = undefined; record.completionAttempt = undefined }
    const epoch = ++record.readEpoch
    const controller = new AbortController()
    const ports = record.ports
    publishIntake(record, { restored: false, intent: null, machine: { ...record.snapshot.machine, error: null } })
    const work = (async () => {
        try {
            const view = parseView(record, await Promise.resolve().then(() => ports.read(record.chat, AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]))))
            if (controller.signal.aborted || epoch !== record.readEpoch) return
            record.savedRevision = view.session.revision
            const machine = hydrateDesktopIntakeMachine({ draft: view.session.draft, stepIndex: view.session.stepIndex, decidedIndustry: view.session.decidedIndustry, knownFirstName: view.session.knownFirstName, revision: view.session.revision })
            const receipt = view.completion
            if (receipt && ['pending', 'uncertain', 'acknowledged', 'failed', 'unavailable'].includes(receipt.state)) {
                record.completionAttempt = { chat: record.chat, requestId: receipt.requestId, expectedRevision: view.session.revision, answers: receipt.answers }
            }
            publishIntake(record, { restored: true, machine: { ...machine, error: receipt && receipt.state !== 'acknowledged' ? receipt.error : null }, completion: receipt, completionUncertain: false, saveFailed: false, conflicted: false, intent: null })
        } catch (error) {
            if (!controller.signal.aborted && epoch === record.readEpoch) patchMachine(record, { error: messageOf(error, 'Could not restore these answers. Try again.') })
        } finally {
            if (record.read?.epoch === epoch) record.read = undefined
        }
    })()
    record.read = { epoch, controller, work }
    return work
}

/** Called only from an event or a fenced classifier result, never from a React state updater. */
export function changeIntake(record: IntakeRecord, machine: DesktopIntakeMachineState, autoPersist: boolean) {
    if (!mayEditIntake(record)) return
    if (sameAnswers([machine.index, machine.draft, machine.decided], [record.snapshot.machine.index, record.snapshot.machine.draft, record.snapshot.machine.decided])) return
    const previousAnswers = toIntake(record.snapshot.machine.draft, record.snapshot.machine.knownFirstName, record.snapshot.machine.decided)
    const answers = toIntake(machine.draft, machine.knownFirstName, machine.decided)
    let completion = record.snapshot.completion
    if (!sameAnswers(previousAnswers, answers) && completion?.state === 'unavailable') {
        record.completionAttempt = undefined
        completion = null
    }
    record.version += 1
    record.dirty = true
    publishIntake(record, { machine: { ...machine, revision: record.savedRevision }, completion })
    if (autoPersist && !record.snapshot.saveFailed) void saveIntake(record)
}

export function requestIntakeHint(record: IntakeRecord, input: string | null) {
    if (record.snapshot.intent?.input === input || !record.snapshot.intent && !input) return
    publishIntake(record, { intent: input ? { id: (record.snapshot.intent?.id ?? 0) + 1, input } : null })
}

export function saveIntake(record: IntakeRecord): Promise<boolean> {
    if (record.work) return record.work
    if (!record.dirty && !record.attempt) return Promise.resolve(true)
    // New admissions freeze on quit; a writer already admitted below drains in full.
    if (isDesktopQuitting()) return Promise.resolve(false)
    const release = holdDraftAdmission()
    const ports = record.ports
    publishIntake(record, { saving: true })
    const work = (async () => {
        try {
            while (record.dirty || record.attempt) {
                if (record.snapshot.conflicted || record.snapshot.completion?.state === 'acknowledged') return false
                const machine = record.snapshot.machine
                const attempt = record.attempt ?? {
                    version: record.version,
                    input: { chat: record.chat, requestId: crypto.randomUUID(), baseRevision: record.savedRevision, stepIndex: machine.index, draft: { ...machine.draft }, decidedIndustry: machine.decided, knownFirstName: machine.knownFirstName },
                }
                record.attempt = attempt
                const view = parseView(record, await ports.save(attempt.input, AbortSignal.timeout(15_000)))
                const session = view.session
                if (!sameAnswers([session.stepIndex, session.draft, session.decidedIndustry, session.knownFirstName], [attempt.input.stepIndex, attempt.input.draft, attempt.input.decidedIndustry, attempt.input.knownFirstName])) {
                    throw new DesktopForemanIntakeClientConflictError(view)
                }
                record.savedRevision = session.revision
                record.attempt = undefined
                if (record.version === attempt.version) record.dirty = false
                publishIntake(record, { completion: view.completion, saveFailed: false, machine: { ...record.snapshot.machine, revision: session.revision, error: record.snapshot.saveFailed ? null : record.snapshot.machine.error } })
            }
            return true
        } catch (error) {
            const conflicted = error instanceof DesktopForemanIntakeClientConflictError || (error as { status?: number } | null)?.status === 409
            publishIntake(record, { saveFailed: true, conflicted, machine: { ...record.snapshot.machine, error: messageOf(error, 'Could not save these answers. Retry saving before continuing.') } })
            return false
        } finally {
            publishIntake(record, { saving: false })
            release()
        }
    })()
    record.work = work
    void work.finally(() => { if (record.work === work) record.work = undefined })
    return work
}

export function submitIntake(record: IntakeRecord): Promise<void> {
    if (record.submitWork) return record.submitWork
    if (isDesktopQuitting() || !record.snapshot.restored || record.snapshot.completion?.state === 'acknowledged') return Promise.resolve()
    const release = holdDraftAdmission()
    const ports = record.ports
    patchMachine(record, { submitting: true, error: null })
    publishIntake(record, { intent: null })
    const work = (async () => {
        try {
            if (!await saveIntake(record) || record.dirty || record.attempt) throw new Error('Save these answers before submitting the intake.')
            if (isDesktopQuitting()) return
            const machine = record.snapshot.machine
            const input = record.completionAttempt ?? { chat: record.chat, requestId: crypto.randomUUID(), expectedRevision: record.savedRevision, answers: toIntake(machine.draft, machine.knownFirstName, machine.decided) }
            record.completionAttempt = input
            // Once admitted, this payload is immutable until a definite no-effect refusal or ACK.
            publishIntake(record, { completionUncertain: true })
            let receipt = parseReceipt(record, await ports.complete(input, AbortSignal.timeout(30_000)), input)
            if (receipt.state === 'pending' || receipt.state === 'uncertain') {
                const recovered = await ports.lookupCompletion(record.chat, input.requestId, AbortSignal.timeout(15_000))
                if (recovered) receipt = parseReceipt(record, recovered, input)
            }
            publishIntake(record, { completion: receipt, completionUncertain: false, machine: { ...record.snapshot.machine, error: receipt.state === 'acknowledged' ? null : receipt.error ?? 'This submission has not been confirmed. Retry to check its result.' } })
        } catch (error) {
            patchMachine(record, { error: messageOf(error, 'This submission was not confirmed. Retry to check its result.') })
        } finally {
            patchMachine(record, { submitting: false })
            release()
        }
    })()
    record.submitWork = work
    void work.finally(() => { if (record.submitWork === work) record.submitWork = undefined })
    return work
}

/** Root includes this in quit custody. Failed/uncertain draft writes must keep the app open. */
export async function flushDesktopForemanIntakeWrites(): Promise<boolean> {
    const current = [...records.values()]
    await Promise.all(current.flatMap(record => [record.work, record.submitWork].filter((work): work is Promise<boolean> | Promise<void> => !!work)))
    return [...records.values()].every(record => !record.dirty && !record.attempt && !record.snapshot.saveFailed && !record.snapshot.completionUncertain)
}

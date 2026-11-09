'use client'

import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { furthestReachable, rolesForIndustry, stepAnswered, type DesktopForemanChatRef, type DesktopForemanIntakeCompletionReceipt, type IntakeDraft, type IntakeStep, type TemplateCategory } from '@rerun/contracts'
import { isDesktopQuitting, subscribeDraftShutdown } from '@/lib/desktop/draft-writes'
import { answersFromDesktopIntake, canAdvanceDesktopIntake, chooseDesktopIntakeIndustry, chooseDesktopIntakeRole, desktopIntakeStepsOf, goToDesktopIntakeStep, nextDesktopIntakeStep, patchDesktopIntakeDraft, siteLooksReadable, skipDesktopIntakeWebsite } from './machine'
import type { DesktopForemanIntakeClientPorts } from './ports'
import { changeIntake, intakeLocked, intakeRecord, mayEditIntake, publishIntake, requestIntakeHint, restoreIntake, saveIntake, submitIntake } from './writes'

const TYPING_PAUSE_MS = 350

export type DesktopForemanIntakeController = {
    steps: IntakeStep[]; step: IntakeStep; index: number; last: boolean; answered: boolean[]; reachable: number; canAdvance: boolean
    draft: IntakeDraft; industry: TemplateCategory | null; deciding: boolean; siteRead: 'reading' | 'ready' | null
    submitting: boolean; restored: boolean; revision: number; error: string | null; completion: DesktopForemanIntakeCompletionReceipt | null; finished: boolean
    locked: boolean; quitting: boolean; canRetry: boolean; saveFailed: boolean; conflicted: boolean; hasSavedProgress: boolean
    set(patch: Partial<IntakeDraft>): void; chooseIndustry(industry: TemplateCategory): void; chooseRole(position: string): void
    skipWebsite(): void; goTo(index: number): void; back(): void; next(): void; roles: string[]
    retryRestore(): void; retrySave(): void; reloadSaved(): void
    sendOwn(text: string): Promise<boolean>
}

/** Original intake questions with a chat-scoped draft writer; restore never starts effects. */
export function useDesktopForemanIntake({ chat, ports, autoPersist = true, active = true }: {
    chat: DesktopForemanChatRef
    ports: DesktopForemanIntakeClientPorts
    /** Labs may defer draft writes until an explicit submit. */
    autoPersist?: boolean
    /** Hidden/closed intake cannot start classification or a site request. */
    active?: boolean
}): DesktopForemanIntakeController {
    const record = useMemo(() => intakeRecord(chat, ports), [chat.workspaceId, chat.chatId])
    const subscribe = useCallback((listener: () => void) => { record.listeners.add(listener); return () => { record.listeners.delete(listener) } }, [record])
    const snapshot = useSyncExternalStore(subscribe, () => record.snapshot, () => record.snapshot)
    const [quitting, setQuitting] = useState(isDesktopQuitting)
    const [observation, setObservation] = useState<{ record: typeof record; intent: object; deciding: boolean; siteRead: 'reading' | 'ready' | null } | null>(null)

    useEffect(() => { record.ports = ports }, [record, ports])
    useEffect(() => {
        void restoreIntake(record)
        return () => { record.read?.controller.abort(); requestIntakeHint(record, null) }
    }, [record])
    useEffect(() => subscribeDraftShutdown(() => {
        const closing = isDesktopQuitting()
        setQuitting(closing)
        if (closing) { record.read?.controller.abort(); requestIntakeHint(record, null) }
        else if (!record.snapshot.restored) void restoreIntake(record)
    }), [record])

    const intent = snapshot.intent
    const locked = intakeLocked(record)
    useEffect(() => {
        if (!active || quitting) { if (intent) requestIntakeHint(record, null); return }
        if (!intent || !snapshot.restored || intakeLocked(record) || snapshot.machine.submitting) return
        const controller = new AbortController()
        const capturedPorts = ports
        const current = () => !controller.signal.aborted && !isDesktopQuitting() && record.snapshot.intent === intent && !intakeLocked(record) && !record.snapshot.machine.submitting
        const timer = setTimeout(() => {
            if (!current()) return
            const site = siteLooksReadable(intent.input)
            setObservation({ record, intent, deciding: !!capturedPorts.decideIndustry, siteRead: site && capturedPorts.analyzeSite ? 'reading' : null })
            if (capturedPorts.decideIndustry) {
                void Promise.resolve().then(() => current() ? capturedPorts.decideIndustry!(intent.input, controller.signal) : null).then(found => {
                    if (!current()) return
                    changeIntake(record, { ...record.snapshot.machine, decided: found }, autoPersist)
                }).catch(() => {
                    if (current()) publishIntake(record, { machine: { ...record.snapshot.machine, error: 'We could not identify the industry. You can continue.' } })
                }).finally(() => {
                    if (current()) setObservation(value => value?.record === record && value.intent === intent ? { ...value, deciding: false } : value)
                })
            }
            if (site && capturedPorts.analyzeSite) {
                void Promise.resolve().then(() => current() ? capturedPorts.analyzeSite!(site, controller.signal) : undefined).then(result => {
                    if (current()) setObservation(value => value?.record === record && value.intent === intent ? { ...value, siteRead: result?.state === 'ready' ? 'ready' : null } : value)
                }).catch(() => {
                    if (!current()) return
                    setObservation(value => value?.record === record && value.intent === intent ? { ...value, siteRead: null } : value)
                    publishIntake(record, { machine: { ...record.snapshot.machine, error: 'We could not read the website. You can continue.' } })
                })
            }
        }, TYPING_PAUSE_MS)
        return () => { clearTimeout(timer); controller.abort() }
    }, [record, ports, intent, snapshot.restored, snapshot.machine.submitting, locked, active, quitting, autoPersist])

    const set = useCallback((patch: Partial<IntakeDraft>) => {
        if (!active || !mayEditIntake(record)) return
        const next = patchDesktopIntakeDraft(record.snapshot.machine, patch)
        changeIntake(record, next, autoPersist)
        if (patch.companyUrl !== undefined) requestIntakeHint(record, siteLooksReadable(next.draft.companyUrl))
    }, [record, autoPersist, active])
    const chooseIndustry = useCallback((industry: TemplateCategory) => {
        if (!active || !mayEditIntake(record)) return
        requestIntakeHint(record, null)
        changeIntake(record, chooseDesktopIntakeIndustry(record.snapshot.machine, industry), autoPersist)
    }, [record, autoPersist, active])
    const chooseRole = useCallback((position: string) => {
        if (!active || !mayEditIntake(record)) return
        const next = chooseDesktopIntakeRole(record.snapshot.machine, position)
        changeIntake(record, next.state, autoPersist)
        if (next.shouldSubmit) void submitIntake(record)
    }, [record, autoPersist, active])
    const skipWebsite = useCallback(() => {
        if (!active || !mayEditIntake(record)) return
        requestIntakeHint(record, null)
        changeIntake(record, skipDesktopIntakeWebsite(record.snapshot.machine), autoPersist)
    }, [record, autoPersist, active])
    const goTo = useCallback((target: number) => {
        if (active && mayEditIntake(record)) changeIntake(record, goToDesktopIntakeStep(record.snapshot.machine, target), autoPersist)
    }, [record, autoPersist, active])
    const next = useCallback(() => {
        if (!active) return
        if (record.completionAttempt && !record.snapshot.machine.submitting && !isDesktopQuitting()) { void submitIntake(record); return }
        if (!mayEditIntake(record)) return
        const next = nextDesktopIntakeStep(record.snapshot.machine)
        changeIntake(record, next.state, autoPersist)
        if (next.shouldSubmit) void submitIntake(record)
        else if (next.hint) requestIntakeHint(record, next.hint)
    }, [record, autoPersist, active])

    const sendOwn = useCallback(async (text: string) => {
        const ownAsk = text.trim()
        if (!active || !ownAsk || ownAsk.length > 4000 || isDesktopQuitting() || record.snapshot.machine.submitting) return false
        const attempt = record.completionAttempt
        if (attempt ? attempt.answers.ownAsk !== ownAsk : !mayEditIntake(record)) return false
        await submitIntake(record, ownAsk)
        const receipt = record.snapshot.completion
        return receipt?.state === 'acknowledged' && receipt.answers.ownAsk === ownAsk
    }, [record, active])

    const { machine } = snapshot
    const steps = desktopIntakeStepsOf(machine)
    const industry = machine.draft.industry ?? machine.decided
    const visibleObservation = observation?.record === record && observation.intent === intent ? observation : null
    return {
        steps, step: steps[machine.index] ?? 'company', index: machine.index, last: machine.index === steps.length - 1,
        answered: steps.map(step => stepAnswered(step, machine.draft)), reachable: furthestReachable(steps, machine.draft), canAdvance: canAdvanceDesktopIntake(machine),
        draft: machine.draft, industry, deciding: visibleObservation?.deciding ?? false, siteRead: visibleObservation?.siteRead ?? null,
        submitting: machine.submitting, restored: snapshot.restored, revision: machine.revision, error: machine.error, completion: snapshot.completion,
        finished: snapshot.completion?.state === 'acknowledged', locked, quitting, canRetry: !!record.completionAttempt && snapshot.completion?.state !== 'acknowledged', saveFailed: snapshot.saveFailed, conflicted: snapshot.conflicted, hasSavedProgress: record.savedRevision > 0 || snapshot.completion !== null,
        sendOwn, set, chooseIndustry, chooseRole, skipWebsite, goTo, back: () => goTo(record.snapshot.machine.index - 1), next, roles: rolesForIndustry(industry),
        retryRestore: () => { if (active) void restoreIntake(record) }, retrySave: () => { if (active) void saveIntake(record) }, reloadSaved: () => { if (active) void restoreIntake(record, true) },
    }
}

export { answersFromDesktopIntake }

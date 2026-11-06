'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
    DesktopForemanChatRef,
    DesktopForemanIntakeCompletionReceipt,
    IntakeDraft,
    IntakeStep,
    TemplateCategory,
} from '@rerun/contracts'
import { furthestReachable, rolesForIndustry, stepAnswered, toIntake } from '@rerun/contracts'

import {
    answersFromDesktopIntake,
    canAdvanceDesktopIntake,
    chooseDesktopIntakeIndustry,
    chooseDesktopIntakeRole,
    desktopIntakeStepsOf,
    goToDesktopIntakeStep,
    hydrateDesktopIntakeMachine,
    initialDesktopIntakeMachine,
    nextDesktopIntakeStep,
    patchDesktopIntakeDraft,
    siteLooksReadable,
    skipDesktopIntakeWebsite,
    type DesktopIntakeMachineState,
} from './machine'
import type { DesktopForemanIntakeClientPorts } from './ports'

const TYPING_PAUSE_MS = 350

export type DesktopForemanIntakeController = {
    steps: IntakeStep[]
    step: IntakeStep
    index: number
    last: boolean
    answered: boolean[]
    reachable: number
    canAdvance: boolean
    draft: IntakeDraft
    industry: TemplateCategory | null
    deciding: boolean
    siteRead: 'reading' | 'ready' | null
    submitting: boolean
    restored: boolean
    revision: number
    error: string | null
    completion: DesktopForemanIntakeCompletionReceipt | null
    /** True once an acknowledged completion exists — card must not reopen effects. */
    finished: boolean
    set: (patch: Partial<IntakeDraft>) => void
    chooseIndustry: (industry: TemplateCategory) => void
    chooseRole: (position: string) => void
    skipWebsite: () => void
    goTo: (index: number) => void
    back: () => void
    next: () => void
    roles: string[]
}

/**
 * Desktop port of useForemanIntake.
 * Local adaptations vs original:
 * - Persists draft/step to the chat-scoped store with revision CAS (original wrote nothing until submit).
 * - Completion is one idempotent request; restore/read never delivers.
 * - Industry/site authorities are optional and fail closed.
 */
export function useDesktopForemanIntake(options: {
    chat: DesktopForemanChatRef
    ports: DesktopForemanIntakeClientPorts
    /** When false, autofocus is suppressed (lab / multi-card pages). */
    autoPersist?: boolean
}): DesktopForemanIntakeController {
    const { chat, ports, autoPersist = true } = options
    const [machine, setMachine] = useState<DesktopIntakeMachineState>(() => initialDesktopIntakeMachine(null))
    const [deciding, setDeciding] = useState(false)
    const [readFor, setReadFor] = useState<string | null>(null)
    const [restored, setRestored] = useState(false)
    const [completion, setCompletion] = useState<DesktopForemanIntakeCompletionReceipt | null>(null)
    const race = useRef(0)
    const sent = useRef<string | null>(null)
    const portsRef = useRef(ports)
    const chatRef = useRef(chat)
    const persistChain = useRef(Promise.resolve())
    const completionRequestId = useRef<string | null>(null)
    const revisionRef = useRef(0)
    const machineRef = useRef(machine)
    useEffect(() => {
        machineRef.current = machine
        revisionRef.current = machine.revision
    }, [machine])

    useEffect(() => {
        portsRef.current = ports
    }, [ports])
    useEffect(() => {
        chatRef.current = chat
    }, [chat])

    // Hydrate once per chat identity. Read-only: never completes.
    useEffect(() => {
        let cancelled = false
        setRestored(false)
        setCompletion(null)
        completionRequestId.current = null
        sent.current = null
        race.current += 1
        void portsRef.current.read(chat).then(view => {
            if (cancelled) return
            if (view.session.chat.workspaceId !== chat.workspaceId || view.session.chat.chatId !== chat.chatId) return
            const hydrated = hydrateDesktopIntakeMachine({
                draft: view.session.draft,
                stepIndex: view.session.stepIndex,
                decidedIndustry: view.session.decidedIndustry,
                knownFirstName: view.session.knownFirstName,
                revision: view.session.revision,
            })
            revisionRef.current = hydrated.revision
            machineRef.current = hydrated
            setMachine(hydrated)
            setCompletion(view.completion)
            setRestored(true)
        })
        return () => {
            cancelled = true
        }
    }, [chat.workspaceId, chat.chatId])

    const persist = useCallback((next: DesktopIntakeMachineState) => {
        if (!autoPersist || !restored) return
        machineRef.current = next
        persistChain.current = persistChain.current.then(async () => {
            const latest = machineRef.current
            const requestId = crypto.randomUUID()
            const payload = {
                chat: chatRef.current,
                requestId,
                baseRevision: revisionRef.current,
                stepIndex: latest.index,
                draft: latest.draft,
                decidedIndustry: latest.decided,
                knownFirstName: latest.knownFirstName,
            }
            try {
                const view = await portsRef.current.save(payload)
                if (view.session.chat.chatId !== chatRef.current.chatId) return
                revisionRef.current = view.session.revision
                setMachine(current => ({
                    ...current,
                    revision: view.session.revision,
                }))
                setCompletion(view.completion)
            } catch (error) {
                const message = error instanceof Error ? error.message : 'We could not save that. Try again.'
                setMachine(current => ({ ...current, error: message }))
            }
        })
    }, [autoPersist, restored])

    const steps = useMemo(() => desktopIntakeStepsOf(machine), [machine])
    const industry = machine.draft.industry ?? machine.decided
    const reachable = furthestReachable(steps, machine.draft)
    const canAdvance = canAdvanceDesktopIntake(machine)
    const readable = siteLooksReadable(machine.draft.companyUrl)
    const picked = !!machine.draft.industry

    const decide = useCallback((input: string) => {
        if (!portsRef.current.decideIndustry) return
        if (sent.current === input) return
        sent.current = input
        const token = (race.current += 1)
        setDeciding(true)
        void portsRef.current
            .decideIndustry(input)
            .then(found => {
                if (race.current !== token) return
                setMachine(current => {
                    const next = { ...current, decided: found }
                    persist(next)
                    return next
                })
            })
            .catch(() => {})
            .finally(() => {
                if (race.current !== token) return
                setDeciding(false)
                setReadFor(input)
            })
    }, [persist])

    useEffect(() => {
        if (!readable || picked || (!portsRef.current.analyzeSite && !portsRef.current.decideIndustry)) return
        const timer = setTimeout(() => {
            portsRef.current.analyzeSite?.(readable)
            decide(readable)
        }, TYPING_PAUSE_MS)
        return () => clearTimeout(timer)
    }, [readable, picked, decide])

    const set = useCallback(
        (patch: Partial<IntakeDraft>) => {
            setMachine(current => {
                const next = patchDesktopIntakeDraft(current, patch)
                persist(next)
                return next
            })
        },
        [persist],
    )

    const skipWebsite = useCallback(() => {
        setMachine(current => {
            if (current.submitting) return current
            race.current += 1
            sent.current = null
            setDeciding(false)
            const next = skipDesktopIntakeWebsite(current)
            persist(next)
            return next
        })
    }, [persist])

    const chooseIndustry = useCallback(
        (pickedIndustry: TemplateCategory) => {
            setMachine(current => {
                const next = chooseDesktopIntakeIndustry(current, pickedIndustry)
                persist(next)
                return next
            })
        },
        [persist],
    )

    const submit = useCallback(async (state: DesktopIntakeMachineState) => {
        if (state.submitting) return
        const requestId = completionRequestId.current ?? crypto.randomUUID()
        completionRequestId.current = requestId
        setMachine(current => ({ ...current, submitting: true, error: null }))
        try {
            // Flush any in-flight draft saves so expectedRevision matches durable state.
            await persistChain.current
            const latest = await portsRef.current.read(chatRef.current)
            if (latest.completion?.state === 'acknowledged') {
                setCompletion(latest.completion)
                setMachine(current => ({ ...current, submitting: false, revision: latest.session.revision }))
                return
            }
            const answers = toIntake(state.draft, state.knownFirstName, state.decided)
            let receipt = await portsRef.current.complete({
                chat: chatRef.current,
                requestId,
                expectedRevision: latest.session.revision,
                answers,
            })
            if (receipt.state === 'failed' || receipt.state === 'pending') {
                // Lost-ACK recovery: same request id, never a second conversation.
                const recovered = await portsRef.current.lookupCompletion(requestId)
                if (recovered) receipt = recovered
            }
            setCompletion(receipt)
            if (receipt.state === 'failed' || receipt.state === 'unavailable') {
                setMachine(current => ({
                    ...current,
                    submitting: false,
                    error: receipt.error ?? (receipt.missingAuthority ? 'Intake completion is not available yet.' : 'We could not save that. Try again.'),
                }))
                return
            }
            setMachine(current => ({ ...current, submitting: false }))
        } catch (error) {
            setMachine(current => ({
                ...current,
                submitting: false,
                error: error instanceof Error ? error.message : 'We could not save that. Try again.',
            }))
        }
    }, [])

    const chooseRole = useCallback(
        (position: string) => {
            setMachine(current => {
                const { state: next, shouldSubmit } = chooseDesktopIntakeRole(current, position)
                if (!shouldSubmit) persist(next)
                else void submit(next)
                return shouldSubmit ? { ...next, submitting: true } : next
            })
        },
        [persist, submit],
    )

    const goTo = useCallback(
        (target: number) => {
            setMachine(current => {
                const next = goToDesktopIntakeStep(current, target)
                persist(next)
                return next
            })
        },
        [persist],
    )

    const next = useCallback(() => {
        setMachine(current => {
            const { state: advanced, shouldSubmit, hint } = nextDesktopIntakeStep(current)
            if (hint) {
                if (siteLooksReadable(hint)) portsRef.current.analyzeSite?.(hint)
                decide(hint)
            }
            if (!shouldSubmit) {
                persist(advanced)
                return advanced
            }
            void submit(advanced)
            return { ...advanced, submitting: true }
        })
    }, [decide, persist, submit])

    const finished = completion?.state === 'acknowledged'

    return {
        steps,
        step: steps[machine.index] ?? 'company',
        index: machine.index,
        last: machine.index === steps.length - 1,
        answered: steps.map(step => stepAnswered(step, machine.draft)),
        reachable,
        canAdvance,
        draft: machine.draft,
        industry,
        deciding,
        siteRead: !readable || picked ? null : readFor === readable ? 'ready' : ports.decideIndustry || ports.analyzeSite ? 'reading' : null,
        submitting: machine.submitting,
        restored,
        revision: machine.revision,
        error: machine.error,
        completion,
        finished,
        set,
        chooseIndustry,
        chooseRole,
        skipWebsite,
        goTo,
        back: () => goTo(machine.index - 1),
        next,
        roles: rolesForIndustry(industry),
    }
}

export { answersFromDesktopIntake }

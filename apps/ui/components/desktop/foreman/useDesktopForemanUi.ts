'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
    applyDesktopDiscoveryEvent,
    applyPlanDecisionResult,
    beginPlanDecision,
    canDispatchForemanNavigation,
    clearPlanDecision,
    createPlanDecisionRequestId,
    DEFAULT_DESKTOP_FOREMAN_PLACEMENT,
    discoveriesFromRun,
    EMPTY_DESKTOP_DISCOVERIES,
    fromContractBuild,
    isLiveForemanView,
    nextStepAllowedWhileLive,
    projectDraftChange,
    projectForemanNextSteps,
    projectOpenChange,
    projectRestoredForemanUi,
    projectTabChange,
    retryPlanDecisionRequest,
    saveForemanUiIfMatching,
    type DesktopDiscoveriesState,
    type DesktopForemanActionPorts,
    type DesktopForemanBuildProgressView,
    type DesktopForemanChatRef,
    type DesktopForemanNextStep,
    type DesktopForemanPersistedUi,
    type DesktopForemanPlacement,
    type DesktopForemanUiTab,
    type DesktopLeadSetupState,
    type DesktopPlanDecisionStatus,
    type DesktopTrustedPlanSnapshot,
} from '@/lib/desktop/foreman-client'

export type UseDesktopForemanUiInput = {
    chat: DesktopForemanChatRef
    ports: DesktopForemanActionPorts
    /** Trusted conversation live run; null = historical. */
    live: { runId: string } | null
    initialOpen?: boolean
}

export function useDesktopForemanUi({ chat, ports, live, initialOpen = false }: UseDesktopForemanUiInput) {
    const [ui, setUi] = useState<DesktopForemanPersistedUi>(() => ({
        workspaceId: chat.workspaceId,
        chatId: chat.chatId,
        open: initialOpen,
        tab: 'assistant',
        draft: '',
        pendingPlanRevisionId: null,
        decision: { status: 'idle' },
        build: null,
        discoveries: null,
        placement: DEFAULT_DESKTOP_FOREMAN_PLACEMENT,
    }))
    const [restored, setRestored] = useState(false)
    const [planSnapshot, setPlanSnapshot] = useState<DesktopTrustedPlanSnapshot | null>(null)
    const [build, setBuild] = useState<DesktopForemanBuildProgressView | null>(null)
    const [discoveries, setDiscoveries] = useState<DesktopDiscoveriesState>(EMPTY_DESKTOP_DISCOVERIES)
    const [leadState, setLeadState] = useState<DesktopLeadSetupState>({ status: 'idle' })
    const [blocked, setBlocked] = useState<'decision_uncertain' | 'build_uncertain' | 'setup_uncertain' | null>(null)
    const [error, setError] = useState<string | null>(null)
    const decisionRef = useRef<DesktopPlanDecisionStatus>({ status: 'idle' })
    decisionRef.current = ui.decision

    const liveScope = useMemo(
        () => ({
            workspaceId: chat.workspaceId,
            chatId: chat.chatId,
            runId: live?.runId ?? null,
            planRevisionId: planSnapshot?.revisionId ?? ui.pendingPlanRevisionId,
        }),
        [chat, live, planSnapshot, ui.pendingPlanRevisionId],
    )

    useEffect(() => {
        let cancelled = false
        void ports.persistence.load(chat).then(saved => {
            if (cancelled) return
            const restoredUi = projectRestoredForemanUi(chat, saved)
            if (restoredUi) {
                setUi(restoredUi)
                if (restoredUi.build) setBuild(restoredUi.build)
                if (restoredUi.discoveries) setDiscoveries(restoredUi.discoveries)
            }
            setRestored(true)
        })
        return () => {
            cancelled = true
        }
    }, [chat, ports.persistence])

    useEffect(() => {
        if (!restored) return
        void saveForemanUiIfMatching(ports.persistence, { ...ui, build, discoveries })
    }, [ui, build, discoveries, ports.persistence, restored])

    useEffect(() => {
        let cancelled = false
        void ports.plans.readShownPlan(chat).then(snapshot => {
            if (!cancelled) setPlanSnapshot(snapshot)
        })
        void ports.plans.readConversationView(chat).then(view => {
            if (cancelled || !view) return
            setBlocked(view.blocked)
            if (view.live?.runId !== live?.runId) {
                // Root supplies live; mismatch stays fail-closed for effects.
            }
        })
        void ports.build.readProgress(chat).then(progress => {
            if (!cancelled) setBuild(progress)
        })
        return () => {
            cancelled = true
        }
    }, [chat, ports.plans, ports.build, live?.runId])

    useEffect(() => {
        if (!isLiveForemanView(live)) {
            setDiscoveries(EMPTY_DESKTOP_DISCOVERIES)
            return
        }
        const caps = ports.discovery.capabilities()
        if (!caps.available) {
            setDiscoveries({
                ...EMPTY_DESKTOP_DISCOVERIES,
                ended: true,
                error: caps.reason || 'Discovery collectors are unavailable.',
            })
            return
        }
        return ports.discovery.subscribe(chat, event => {
            setDiscoveries(current => applyDesktopDiscoveryEvent(current, event))
        })
    }, [chat, live, ports.discovery])

    const setOpen = useCallback((open: boolean) => setUi(current => projectOpenChange(current, open)), [])
    const setTab = useCallback((tab: DesktopForemanUiTab) => setUi(current => projectTabChange(current, tab)), [])
    const setDraft = useCallback((draft: string) => setUi(current => projectDraftChange(current, draft)), [])
    const setPlacement = useCallback((placement: DesktopForemanPlacement) => setUi(current => ({ ...current, placement })), [])

    useEffect(() => {
        if (!ui.open) return
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key !== 'Escape') return
            if (event.target instanceof Element && event.target.closest('[role="dialog"], [role="alertdialog"], [role="menu"]')) return
            setOpen(false)
        }
        window.addEventListener('keydown', onKeyDown)
        return () => window.removeEventListener('keydown', onKeyDown)
    }, [ui.open, setOpen])

    const submitDecision = useCallback(
        async (kind: 'confirm' | 'ask_changes', feedback?: string) => {
            if (!planSnapshot || blocked) return
            if (!isLiveForemanView(live)) {
                setError('Plan decisions require the live Foreman chat.')
                return
            }
            const existing = retryPlanDecisionRequest(decisionRef.current)
            const request =
                existing ??
                (kind === 'confirm'
                    ? {
                          decision: 'confirm' as const,
                          requestId: createPlanDecisionRequestId(),
                          chat,
                          planId: planSnapshot.planId,
                          revisionId: planSnapshot.revisionId,
                          digest: planSnapshot.digest,
                      }
                    : {
                          decision: 'ask_changes' as const,
                          requestId: createPlanDecisionRequestId(),
                          chat,
                          planId: planSnapshot.planId,
                          revisionId: planSnapshot.revisionId,
                          digest: planSnapshot.digest,
                          feedback: (feedback ?? '').trim() || 'Please change the plan.',
                      })
            setUi(current => ({ ...current, decision: beginPlanDecision(current.decision, request), pendingPlanRevisionId: request.revisionId }))
            try {
                const result = await ports.decisions.submit(request)
                setUi(current => ({
                    ...current,
                    decision: applyPlanDecisionResult(current.decision, liveScope, result),
                }))
            } catch (err) {
                setUi(current => ({
                    ...current,
                    decision: applyPlanDecisionResult(current.decision, liveScope, {
                        ok: false,
                        requestId: request.requestId,
                        revisionId: request.revisionId,
                        error: err instanceof Error ? err.message : 'Decision failed.',
                        uncertain: true,
                    }),
                }))
            }
        },
        [planSnapshot, blocked, live, chat, ports.decisions, liveScope],
    )

    const nextSteps = useMemo(() => projectForemanNextSteps(build).filter(step => nextStepAllowedWhileLive(isLiveForemanView(live), step) || step.kind === 'unavailable'), [build, live])

    const navigate = useCallback(
        (intent: Parameters<typeof canDispatchForemanNavigation>[2]['intent']) => {
            const request = {
                intent,
                workspaceId: chat.workspaceId,
                chatId: chat.chatId,
                runId: live?.runId ?? null,
                liveObserved: isLiveForemanView(live),
            }
            if (!canDispatchForemanNavigation(liveScope, live, request)) return
            void ports.navigation.dispatch(request)
        },
        [chat, live, liveScope, ports.navigation],
    )

    const startLead = useCallback(
        async (step: Extract<DesktopForemanNextStep, { kind: 'start_lead' }>) => {
            if (!isLiveForemanView(live) || blocked) return
            const requestId = createPlanDecisionRequestId()
            setLeadState({ status: 'starting', agentId: step.agentId, requestId, itemKey: step.itemKey, buildId: step.buildId })
            const result = await ports.build.act({
                action: 'start_lead_setup',
                requestId,
                chat,
                buildId: step.buildId,
                itemKey: step.itemKey,
            })
            if ('error' in result) {
                setLeadState({
                    status: result.uncertain ? 'unavailable' : 'failed',
                    agentId: step.agentId,
                    ...(result.uncertain ? { reason: result.error } : { error: result.error }),
                } as DesktopLeadSetupState)
                return
            }
            setBuild(result)
            const sessionId = result.setup.sessionId
            if (result.setup.agentId && sessionId) {
                setLeadState({ status: 'started', agentId: result.setup.agentId, sessionId })
                navigate({ kind: 'open_setup', agentId: result.setup.agentId })
            } else {
                setLeadState({ status: 'failed', agentId: step.agentId, error: 'Lead setup did not return a session.' })
            }
        },
        [live, blocked, ports.build, chat, navigate],
    )

    return {
        ui,
        restored,
        planSnapshot,
        build,
        discoveries,
        leadState,
        blocked,
        error,
        nextSteps,
        live: isLiveForemanView(live),
        setOpen,
        setTab,
        setDraft,
        setPlacement,
        clearDecision: () => setUi(current => ({ ...current, decision: clearPlanDecision(current.decision) })),
        confirmPlan: () => void submitDecision('confirm'),
        askChanges: (feedback?: string) => void submitDecision('ask_changes', feedback),
        retryDecision: () => {
            const request = retryPlanDecisionRequest(decisionRef.current)
            if (!request) return
            void submitDecision(request.decision, request.decision === 'ask_changes' ? request.feedback : undefined)
        },
        startLead,
        navigate,
        setDiscoveriesFromRun: (run: Parameters<typeof discoveriesFromRun>[0]) => setDiscoveries(discoveriesFromRun(run)),
        ingestContractBuild: (contractBuild: Parameters<typeof fromContractBuild>[0]) => setBuild(fromContractBuild(contractBuild, chat)),
    }
}

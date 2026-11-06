'use client'

import { isDesktopQuitting } from '@/lib/desktop/draft-writes'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
    applyDesktopDiscoveryEvent, applyPlanDecisionResult, beginPlanDecision, canSubmitPlanDecision,
    createPlanDecisionRequestId, DEFAULT_DESKTOP_FOREMAN_PLACEMENT, discoveriesFromRun,
    EMPTY_DESKTOP_DISCOVERIES, fromContractBuild, isLiveForemanView, loadForemanUiAfterWrites,
    projectForemanNextSteps, projectRestoredForemanUi, retryPlanDecisionRequest,
    sameForemanChat, saveForemanUiIfMatching,
    type DesktopDiscoveriesState, type DesktopForemanActionPorts, type DesktopForemanBuildProgressView,
    type DesktopForemanChatRef, type DesktopForemanNextStep, type DesktopForemanPersistedUi,
    type DesktopForemanPlacement, type DesktopForemanUiTab, type DesktopLeadSetupState,
    type DesktopPlanDecisionResult, type DesktopTrustedPlanSnapshot,
} from '@/lib/desktop/foreman-client'

export type UseDesktopForemanUiInput = {
    chat: DesktopForemanChatRef
    ports: DesktopForemanActionPorts
    /** Only automatic model navigation/discovery needs a live run. Human card actions do not. */
    live: { runId: string } | null
    initialOpen?: boolean
    refreshKey?: string | number
    onClose?: () => void
}
type State = {
    ui: DesktopForemanPersistedUi
    restored: boolean
    planSnapshot: DesktopTrustedPlanSnapshot | null
    build: DesktopForemanBuildProgressView | null
    discoveries: DesktopDiscoveriesState
    leadState: DesktopLeadSetupState
    blocked: 'decision_uncertain' | 'build_uncertain' | 'setup_uncertain' | null
    error: string | null
}
function initialState(chat: DesktopForemanChatRef, open: boolean): State {
    return {
        ui: { ...chat, open, tab: 'assistant', draft: '', pendingPlanRevisionId: null, decision: { status: 'idle' },
            build: null, discoveries: null, placement: DEFAULT_DESKTOP_FOREMAN_PLACEMENT },
        restored: false, planSnapshot: null, build: null, discoveries: EMPTY_DESKTOP_DISCOVERIES,
        leadState: { status: 'idle' }, blocked: null, error: null,
    }
}
const messageOf = (error: unknown) => error instanceof Error ? error.message : 'Foreman request failed.'
const persisted = (state: State): DesktopForemanPersistedUi => ({ ...state.ui, build: state.build, discoveries: state.discoveries })

export function useDesktopForemanUi({ chat, ports, live, initialOpen = false, refreshKey, onClose }: UseDesktopForemanUiInput) {
    // Each identity has a distinct lifetime even when callers reuse the mounted column. A callback
    // retained by the previous chat cannot write to this one, including before effects clean up.
    const owner = useMemo(() => ({
        chat: { workspaceId: chat.workspaceId, chatId: chat.chatId },
        state: initialState(chat, initialOpen), active: false, generation: 0,
        controllers: new Set<AbortController>(), discoveryVersion: 0,
        earlyUi: {} as Partial<Pick<DesktopForemanPersistedUi, 'open' | 'tab' | 'placement'>>,
        sending: false,
        buildAction: null as { action: 'stop' | 'resume'; requestId: string; buildId: string } | null,
        buildBusy: false,
    // initialOpen is an initial value, never a command to reopen a closed panel.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }), [chat.workspaceId, chat.chatId, ports.persistence])
    const current = useRef(owner)
    current.current = owner
    const liveRef = useRef(live)
    liveRef.current = live
    const [, redraw] = useState(0)
    const [refresh, setRefresh] = useState(0)
    const valid = useCallback((generation = owner.generation) => current.current === owner && owner.active && owner.generation === generation, [owner])
    const commit = useCallback((change: (state: State) => State, save = true) => {
        if (!valid()) return
        owner.state = change(owner.state)
        redraw(n => n + 1)
        if (save && owner.state.restored) {
            const generation = owner.generation
            void saveForemanUiIfMatching(ports.persistence, persisted(owner.state)).catch(error => {
                if (!valid(generation)) return
                owner.state = { ...owner.state, error: `Could not save Foreman chat: ${messageOf(error)}` }
                redraw(n => n + 1)
            })
        }
    }, [owner, ports.persistence, valid])

    useEffect(() => {
        owner.active = true
        const generation = ++owner.generation
        void loadForemanUiAfterWrites(ports.persistence, owner.chat).then(saved => {
            if (!valid(generation)) return
            const restored = projectRestoredForemanUi(owner.chat, saved)
            if (restored) {
                // A pending write can survive a lost acknowledgement or a quit. Never automatically
                // repeat the effect; let an explicit retry recover its original immutable request.
                const decision = restored.decision.status === 'pending'
                    ? { status: 'uncertain' as const, request: restored.decision.request, at: Date.now(), error: 'The previous decision was not acknowledged. Retry to check its saved result.' }
                    : restored.decision
                commit(state => ({ ...state, restored: true, ui: { ...restored, ...owner.earlyUi, decision },
                    build: restored.build, discoveries: restored.discoveries ?? EMPTY_DESKTOP_DISCOVERIES }))
            } else commit(state => ({ ...state, restored: true }))
        }).catch(error => {
            if (valid(generation)) commit(state => ({ ...state, error: `Could not restore Foreman chat: ${messageOf(error)}` }), false)
        })
        return () => {
            owner.active = false
            for (const controller of owner.controllers) controller.abort()
            owner.controllers.clear()
        }
    }, [owner, ports.persistence, valid, commit])

    const { ui, restored, planSnapshot, build, discoveries, leadState, blocked, error } = owner.state
    useEffect(() => {
        if (!restored) return
        const generation = owner.generation
        const controller = new AbortController()
        owner.controllers.add(controller)
        const discoveryVersion = owner.discoveryVersion
        void Promise.all([
            ports.plans.readShownPlan(owner.chat, controller.signal),
            ports.plans.readConversationView(owner.chat, controller.signal),
            ports.build.readProgress(owner.chat, controller.signal),
        ]).then(([snapshot, view, progress]) => {
            if (!valid(generation) || controller.signal.aborted) return
            if (snapshot && !sameForemanChat(snapshot, owner.chat)) throw new Error('Foreman plan belongs to a different chat.')
            if (view && !sameForemanChat(view.chat, owner.chat)) throw new Error('Foreman view belongs to a different chat.')
            if (progress && !sameForemanChat(progress, owner.chat)) throw new Error('Foreman build belongs to a different chat.')
            if (view?.discovery && !sameForemanChat(view.discovery.chat, owner.chat)) throw new Error('Foreman discoveries belong to a different chat.')
            const currentPlan = !view || snapshot?.revisionId === view.currentRevisionId ? snapshot : null
            commit(state => ({ ...state, planSnapshot: currentPlan, blocked: view?.blocked ?? null,
                // A settled decision belongs to its reviewed revision. It must not
                // disable confirmation of a newly shown plan in this same chat.
                // Pending/uncertain receipts retain their exact recovery identity.
                ui: currentPlan && (state.ui.decision.status === 'acknowledged' || state.ui.decision.status === 'failed')
                    && state.ui.decision.request.revisionId !== currentPlan.revisionId
                    ? { ...state.ui, decision: { status: 'idle' }, pendingPlanRevisionId: null } : state.ui,
                build: view ? (view.build ? fromContractBuild(view.build, owner.chat) : null) : progress,
                discoveries: view && owner.discoveryVersion === discoveryVersion ? discoveriesFromRun(view.discovery) : state.discoveries }))
        }).catch(error => {
            if (valid(generation) && !controller.signal.aborted) commit(state => ({ ...state, error: messageOf(error) }), false)
        }).finally(() => owner.controllers.delete(controller))
        return () => { controller.abort(); owner.controllers.delete(controller) }
    }, [owner, restored, ports.plans, ports.build, live?.runId, refresh, refreshKey, valid, commit])

    useEffect(() => {
        if (!restored || !isLiveForemanView(live)) return
        const runId = live.runId
        const generation = owner.generation
        const controller = new AbortController()
        owner.controllers.add(controller)
        let unsubscribe: (() => void) | undefined
        try {
            // Historical findings stay visible even if new collectors are unavailable.
            if (ports.discovery.capabilities().available) unsubscribe = ports.discovery.subscribe(owner.chat, event => {
                if (!valid(generation) || controller.signal.aborted || liveRef.current?.runId !== runId) return
                owner.discoveryVersion++
                commit(state => ({ ...state, discoveries: applyDesktopDiscoveryEvent(state.discoveries, event) }))
            }, controller.signal)
        } catch (error) {
            commit(state => ({ ...state, error: messageOf(error) }), false)
        }
        return () => { controller.abort(); owner.controllers.delete(controller); unsubscribe?.() }
    }, [owner, restored, live?.runId, ports.discovery, valid, commit])

    const setOpen = useCallback((open: boolean) => {
        if (!valid()) return
        owner.earlyUi.open = open
        commit(state => ({ ...state, ui: { ...state.ui, open } }))
        if (!open) onClose?.()
    }, [owner, commit, onClose, valid])
    const setTab = useCallback((tab: DesktopForemanUiTab) => {
        owner.earlyUi.tab = tab
        commit(state => ({ ...state, ui: { ...state.ui, tab } }))
    }, [owner, commit])
    const setDraft = useCallback((draft: string) => {
        if (!isDesktopQuitting() && owner.state.restored) commit(state => ({ ...state, ui: { ...state.ui, draft } }))
    }, [owner, commit])
    const setPlacement = useCallback((placement: DesktopForemanPlacement) => {
        owner.earlyUi.placement = placement
        commit(state => ({ ...state, ui: { ...state.ui, placement } }))
    }, [owner, commit])
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

    const submitDecision = useCallback(async (kind: 'confirm' | 'ask_changes', feedback?: string) => {
        const state = owner.state
        if (isDesktopQuitting() || !valid() || !state.restored || !state.planSnapshot || !canSubmitPlanDecision(state.ui.decision)) return
        const snapshot = state.planSnapshot
        const existing = retryPlanDecisionRequest(state.ui.decision)
        if (state.blocked && !(state.blocked === 'decision_uncertain' && existing)) return
        if (existing && (existing.revisionId !== snapshot.revisionId || existing.digest !== snapshot.digest || !sameForemanChat(existing.chat, owner.chat))) {
            commit(current => ({ ...current, error: 'The saved decision belongs to a different plan revision. Reopen its original plan to check the result.' }), false)
            return
        }
        const generation = owner.generation
        const controller = new AbortController()
        owner.controllers.add(controller)
        let dispatched = false
        try {
            const request = existing ?? (kind === 'confirm'
                ? { decision: 'confirm' as const, requestId: createPlanDecisionRequestId(), chat: owner.chat, planId: snapshot.planId, revisionId: snapshot.revisionId, digest: snapshot.digest }
                : { decision: 'ask_changes' as const, requestId: createPlanDecisionRequestId(), chat: owner.chat, planId: snapshot.planId, revisionId: snapshot.revisionId, digest: snapshot.digest, feedback: feedback?.trim() || 'Please change the plan.' })
            commit(current => ({ ...current, error: null, ui: { ...current.ui, decision: beginPlanDecision(current.ui.decision, request), pendingPlanRevisionId: request.revisionId } }), false)
            // Persist the idempotency identity before the first possible provider-side effect.
            await saveForemanUiIfMatching(ports.persistence, persisted(owner.state))
            if (!valid(generation) || controller.signal.aborted || isDesktopQuitting()) return
            dispatched = true
            const result = await ports.decisions.submit(request, controller.signal)
            if (!valid(generation) || controller.signal.aborted) return
            const apply = (current: State, value: DesktopPlanDecisionResult): State => ({ ...current, ui: { ...current.ui,
                decision: applyPlanDecisionResult(current.ui.decision, { ...owner.chat, runId: liveRef.current?.runId ?? null, planRevisionId: current.planSnapshot?.revisionId ?? null }, value) } })
            commit(current => apply(current, result))
            if (result.ok) setRefresh(n => n + 1)
        } catch (error) {
            if (!valid(generation) || controller.signal.aborted) return
            commit(current => ({ ...current, error: messageOf(error), ui: { ...current.ui, decision: current.ui.decision.status === 'pending'
                ? { status: dispatched ? 'uncertain' : 'failed', request: current.ui.decision.request, error: messageOf(error), at: Date.now() }
                : current.ui.decision } }))
        } finally { owner.controllers.delete(controller) }
    }, [owner, valid, commit, ports.decisions, ports.persistence])

    const navigate = useCallback((intent: Parameters<DesktopForemanActionPorts['navigation']['dispatch']>[0]['intent']) => {
        if (isDesktopQuitting() || !valid() || !owner.state.restored) return
        const generation = owner.generation
        try {
            void Promise.resolve(ports.navigation.dispatch({ intent, ...owner.chat, runId: liveRef.current?.runId ?? null, liveObserved: isLiveForemanView(liveRef.current) })).catch(error => {
                if (valid(generation)) commit(state => ({ ...state, error: messageOf(error) }), false)
            })
        } catch (error) { if (valid(generation)) commit(state => ({ ...state, error: messageOf(error) }), false) }
    }, [owner, ports.navigation, valid, commit])
    const startLead = useCallback(async (step: Extract<DesktopForemanNextStep, { kind: 'start_lead' }>) => {
        const state = owner.state
        if (isDesktopQuitting() || !valid() || !state.restored || state.blocked || state.leadState.status === 'starting' || state.build?.buildId !== step.buildId || !projectForemanNextSteps(state.build).some(candidate => candidate.kind === 'start_lead' && candidate.itemKey === step.itemKey && candidate.agentId === step.agentId)) return
        const generation = owner.generation
        const controller = new AbortController()
        owner.controllers.add(controller)
        try {
            const requestId = createPlanDecisionRequestId()
            commit(current => ({ ...current, leadState: { status: 'starting', agentId: step.agentId, requestId, itemKey: step.itemKey, buildId: step.buildId } }), false)
            const result = await ports.build.act({ action: 'start_lead_setup', requestId, chat: owner.chat, buildId: step.buildId, itemKey: step.itemKey }, controller.signal)
            if (!valid(generation) || controller.signal.aborted) return
            if ('error' in result) throw new Error(result.error)
            if (!sameForemanChat(result, owner.chat) || result.buildId !== step.buildId) throw new Error('Lead setup returned a different Foreman build.')
            if (!result.setup.agentId || !result.setup.sessionId) throw new Error('Lead setup did not return a session.')
            commit(current => ({ ...current, build: result, leadState: { status: 'started', agentId: result.setup.agentId!, sessionId: result.setup.sessionId! } }))
            navigate({ kind: 'open_setup', agentId: result.setup.agentId })
        } catch (error) {
            if (valid(generation) && !controller.signal.aborted) commit(current => ({ ...current, leadState: { status: 'failed', agentId: step.agentId, error: messageOf(error) } }), false)
        } finally { owner.controllers.delete(controller) }
    }, [owner, valid, commit, ports.build, navigate])
    const sendMessage = useCallback(async (text: string) => {
        if (isDesktopQuitting() || !valid() || !owner.state.restored || owner.state.blocked || owner.sending) return false
        const generation = owner.generation
        owner.sending = true
        const submittedDraft = owner.state.ui.draft
        try {
            const accepted = await ports.conversation.sendMessage(text)
            if (valid(generation) && accepted && owner.state.ui.draft === submittedDraft && submittedDraft.trim() === text) setDraft('')
            return accepted
        } catch (error) {
            if (valid(generation)) commit(state => ({ ...state, error: messageOf(error) }), false)
            return false
        } finally { owner.sending = false }
    }, [owner, ports.conversation, valid, commit, setDraft])
    const stop = useCallback(async () => {
        if (!valid()) return
        const generation = owner.generation
        try { await ports.conversation.stop() }
        catch (error) { if (valid(generation)) commit(state => ({ ...state, error: messageOf(error) }), false) }
    }, [ports.conversation, valid, commit, owner])

    const actOnBuild = useCallback(async (action: 'stop' | 'resume') => {
        const build = owner.state.build
        if (isDesktopQuitting() || !valid() || !owner.state.restored || !build || owner.buildBusy) return
        if (action === 'resume' && !['uncertain','stopped','failed','partial'].includes(build.status) && !['pending','uncertain'].includes(build.setup.state)) return
        if (action === 'stop' && !['reserved','running','uncertain'].includes(build.status)) return
        const generation = owner.generation, controller = new AbortController()
        const prior = owner.buildAction
        const request = prior?.action === action && prior.buildId === build.buildId ? prior : { action, buildId: build.buildId, requestId: createPlanDecisionRequestId() }
        owner.buildAction = request; owner.buildBusy = true; owner.controllers.add(controller)
        commit(state => ({ ...state, error: null }), false)
        try {
            const result = await ports.build.act({ ...request, chat: owner.chat }, controller.signal)
            if (!valid(generation) || controller.signal.aborted) return
            if ('error' in result) throw new Error(result.error)
            if (!sameForemanChat(result, owner.chat) || result.buildId !== build.buildId) throw new Error('The build response belongs to another Foreman chat.')
            owner.buildAction = null
            commit(state => ({ ...state, build: result }))
            setRefresh(n => n + 1)
        } catch (error) {
            if (valid(generation) && !controller.signal.aborted) commit(state => ({ ...state, error: messageOf(error) }), false)
        } finally {
            owner.controllers.delete(controller); owner.buildBusy = false
            if (valid(generation)) redraw(n => n + 1)
        }
    }, [owner, valid, commit, ports.build])

    return {
        ui, restored, planSnapshot, build, discoveries, leadState, blocked, error,
        nextSteps: projectForemanNextSteps(build), live: isLiveForemanView(live),
        setOpen, setTab, setDraft, setPlacement, sendMessage, stop, actOnBuild, buildBusy: owner.buildBusy,
        clearDecision: () => { if (owner.state.ui.decision.status !== 'pending' && owner.state.ui.decision.status !== 'uncertain') commit(state => ({ ...state, ui: { ...state.ui, decision: { status: 'idle' } } })) },
        confirmPlan: () => void submitDecision('confirm'), askChanges: (feedback?: string) => void submitDecision('ask_changes', feedback),
        retryDecision: () => { const request = retryPlanDecisionRequest(owner.state.ui.decision); if (request) void submitDecision(request.decision, request.decision === 'ask_changes' ? request.feedback : undefined) },
        startLead, navigate,
        setDiscoveriesFromRun: (run: Parameters<typeof discoveriesFromRun>[0]) => { if (valid()) { owner.discoveryVersion++; commit(state => ({ ...state, discoveries: discoveriesFromRun(run) })) } },
        ingestContractBuild: (contractBuild: Parameters<typeof fromContractBuild>[0]) => commit(state => ({ ...state, build: fromContractBuild(contractBuild, owner.chat) })),
    }
}

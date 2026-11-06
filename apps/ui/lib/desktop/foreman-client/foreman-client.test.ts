import { describe, expect, it } from 'vitest'
import {
    acceptsForemanReply,
    applyDesktopDiscoveryEvent,
    applyPlanDecisionResult,
    beginPlanDecision,
    canDispatchForemanNavigation,
    createPlanDecisionRequestId,
    EMPTY_DESKTOP_DISCOVERIES,
    fromContractBuild,
    isLiveForemanView,
    parseDesktopForemanChatRef,
    projectBuildProgress,
    projectForemanNextSteps,
    projectPlanCard,
    projectRestoredForemanUi,
    projectTabChange,
    readTrustedPlan,
    retryPlanDecisionRequest,
    revisionToTrustedSnapshot,
} from './index'

const chat = { workspaceId: 'ws-1', chatId: 'fmc_abcdefgh' }

describe('foreman identity', () => {
    it('parses exact chat refs and fails closed on extras', () => {
        expect(parseDesktopForemanChatRef(chat)).toEqual(chat)
        expect(parseDesktopForemanChatRef({ ...chat, runId: 'r' })).toBeNull()
    })

    it('gates stale replies by workspace/chat/run/revision', () => {
        const live = { ...chat, runId: 'run-1', planRevisionId: 'fmr_abcdefgh' }
        expect(acceptsForemanReply(live, { chatId: 'fmc_otherxyz1' })).toBe(false)
        expect(acceptsForemanReply(live, { runId: 'run-1', planRevisionId: 'fmr_abcdefgh' })).toBe(true)
    })

    it('treats null live as historical', () => {
        expect(isLiveForemanView(null)).toBe(false)
        expect(isLiveForemanView({ runId: 'run-1' })).toBe(true)
    })
})

describe('plan revisions and decisions', () => {
    const snapshot = revisionToTrustedSnapshot({
        planId: 'fmp_abcdefgh',
        revisionId: 'fmr_abcdefgh',
        digest: 'a'.repeat(64),
        chat,
        runId: 'run-1',
        state: 'shown',
        plan: {
            title: 'Your first coworker',
            boxes: [{ key: 'box-0', name: 'Ops' }],
            items: [{ key: 'item-0', kind: 'agent', name: 'Alex', role: 'Ops lead', when: 'Each morning', boxKey: 'box-0' }],
        },
    })

    it('projects the exact revision and never treats prose as answered', () => {
        const projected = projectPlanCard(snapshot)
        expect(projected.revisionId).toBe('fmr_abcdefgh')
        expect(projected.decision).toBeNull()
        expect(projected.view?.groups[0]?.items[0]?.name).toBe('Alex')
    })

    it('retains request fingerprint across failed acknowledgement retry', () => {
        const request = {
            decision: 'confirm' as const,
            requestId: createPlanDecisionRequestId(),
            chat,
            planId: snapshot.planId,
            revisionId: snapshot.revisionId,
            digest: snapshot.digest,
        }
        let state = beginPlanDecision({ status: 'idle' }, request)
        state = applyPlanDecisionResult(
            state,
            { ...chat, runId: 'run-1', planRevisionId: snapshot.revisionId },
            { ok: false, requestId: request.requestId, revisionId: snapshot.revisionId, error: 'lost ack', uncertain: true },
        )
        expect(state.status).toBe('uncertain')
        expect(retryPlanDecisionRequest(state)?.requestId).toBe(request.requestId)
    })

    it('marks uncertain when a newer revision is live before ack', () => {
        const request = {
            decision: 'confirm' as const,
            requestId: createPlanDecisionRequestId(),
            chat,
            planId: snapshot.planId,
            revisionId: snapshot.revisionId,
            digest: snapshot.digest,
        }
        const pending = beginPlanDecision({ status: 'idle' }, request)
        const next = applyPlanDecisionResult(
            pending,
            { ...chat, runId: 'run-1', planRevisionId: 'fmr_newer0001' },
            { ok: true, requestId: request.requestId, revisionId: snapshot.revisionId, decisionId: 'fmd_abcdefgh' },
        )
        expect(next.status).toBe('uncertain')
    })
})

describe('build progress and navigation', () => {
    const build = fromContractBuild(
        {
            buildId: 'fmb_abcdefgh',
            revisionId: 'fmr_abcdefgh',
            state: 'partial',
            leadItemKey: 'item-0',
            setup: { state: 'not_started', agentId: null, sessionId: null, error: null },
            items: [
                {
                    itemKey: 'item-0',
                    order: 0,
                    title: 'Alex',
                    state: 'created',
                    created: { agentIds: ['agent-1'], spaceId: 'space-1', sessionId: 'sess-1' },
                    failure: null,
                    error: null,
                    lead: true,
                },
                {
                    itemKey: 'item-1',
                    order: 1,
                    title: 'Blake',
                    state: 'failed',
                    created: null,
                    failure: 'creation_failed',
                    error: 'Could not create',
                    lead: false,
                },
            ],
        },
        chat,
    )

    it('exposes exact ids and partial failures without name lookup', () => {
        const projected = projectBuildProgress(build)
        expect(projected.partial).toBe(true)
        expect(projected.navigable[0]).toEqual({ itemKey: 'item-0', agentId: 'agent-1', boxId: 'space-1', sessionId: 'sess-1' })
        expect(projected.items[1]?.error).toBe('Could not create')
    })

    it('projects lead setup next step from exact lead item', () => {
        const steps = projectForemanNextSteps(build)
        expect(steps[0]).toMatchObject({ kind: 'start_lead', agentId: 'agent-1', itemKey: 'item-0', buildId: 'fmb_abcdefgh' })
    })

    it('blocks navigation when not live-observed', () => {
        const liveScope = { ...chat, runId: 'run-1', planRevisionId: null }
        expect(
            canDispatchForemanNavigation(liveScope, null, {
                intent: { kind: 'open_coworker', agentId: 'agent-1', sessionId: null },
                workspaceId: chat.workspaceId,
                chatId: chat.chatId,
                runId: 'run-1',
                liveObserved: true,
            }),
        ).toBe(false)
        expect(
            canDispatchForemanNavigation(liveScope, { runId: 'run-1' }, {
                intent: { kind: 'open_box', spaceId: 'space-1' },
                workspaceId: chat.workspaceId,
                chatId: chat.chatId,
                runId: 'run-1',
                liveObserved: true,
            }),
        ).toBe(true)
    })
})

describe('discoveries and restart projection', () => {
    it('keeps unavailable collectors visible and invents nothing', () => {
        let state = applyDesktopDiscoveryEvent(EMPTY_DESKTOP_DISCOVERIES, { type: 'pending', source: 'linkedinCompany' })
        state = applyDesktopDiscoveryEvent(state, { type: 'unavailable', source: 'linkedinCompany' })
        expect(state.unavailable).toContain('linkedinCompany')
        expect(state.entries.some(entry => entry.type === 'unavailable')).toBe(true)
    })

    it('restores only exact workspace/chat drafts and preserves decision on tab change', () => {
        const saved = {
            workspaceId: chat.workspaceId,
            chatId: chat.chatId,
            open: true,
            tab: 'assistant' as const,
            draft: 'keep me',
            pendingPlanRevisionId: 'fmr_abcdefgh',
            decision: { status: 'pending' as const, request: {
                decision: 'confirm' as const,
                requestId: '00000000-0000-4000-8000-000000000001',
                chat,
                planId: 'fmp_abcdefgh',
                revisionId: 'fmr_abcdefgh',
                digest: 'a'.repeat(64),
            }, startedAt: 1 },
            build: null,
            discoveries: null,
            placement: { mode: 'dock' as const, side: 'right' as const, width: 420, height: 640, dockWidth: 420 },
        }
        expect(projectRestoredForemanUi(chat, saved)?.draft).toBe('keep me')
        expect(projectRestoredForemanUi({ workspaceId: 'other', chatId: chat.chatId }, saved)).toBeNull()
        const tabbed = projectTabChange(saved, 'routines')
        expect(tabbed.draft).toBe('keep me')
        expect(tabbed.decision.status).toBe('pending')
    })

    it('groups orphan agents without dropping them', () => {
        const view = readTrustedPlan({
            title: 'Team',
            boxes: [{ name: 'Sales' }],
            items: [
                { kind: 'agent', name: 'Sam', role: 'AE', box: 'Sales' },
                { kind: 'agent', name: 'Pat', role: 'Support', box: 'Support' },
            ],
        })
        expect(view.groups).toHaveLength(2)
        expect(view.groups[1]?.items[0]?.name).toBe('Pat')
    })
})

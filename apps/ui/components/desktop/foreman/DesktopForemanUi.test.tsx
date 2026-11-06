import { describe, expect, it } from 'vitest'
import { canSubmitPlanDecision, projectDecisionBusy, projectOpenChange, DEFAULT_DESKTOP_FOREMAN_PLACEMENT } from '@/lib/desktop/foreman-client'

describe('Desktop Foreman UI invariants', () => {
    it('disables conflicting submissions while a decision is pending', () => {
        expect(projectDecisionBusy({ status: 'pending', request: {
            decision: 'confirm',
            requestId: '00000000-0000-4000-8000-000000000001',
            chat: { workspaceId: 'ws', chatId: 'fmc_abcdefgh' },
            planId: 'fmp_abcdefgh',
            revisionId: 'fmr_abcdefgh',
            digest: 'a'.repeat(64),
        }, startedAt: 1 })).toBe(true)
        expect(canSubmitPlanDecision({ status: 'pending', request: {
            decision: 'confirm',
            requestId: '00000000-0000-4000-8000-000000000001',
            chat: { workspaceId: 'ws', chatId: 'fmc_abcdefgh' },
            planId: 'fmp_abcdefgh',
            revisionId: 'fmr_abcdefgh',
            digest: 'a'.repeat(64),
        }, startedAt: 1 })).toBe(false)
    })

    it('closing the column does not clear drafts or confirm plans', () => {
        const current = {
            workspaceId: 'ws',
            chatId: 'fmc_abcdefgh',
            open: true,
            tab: 'assistant' as const,
            draft: 'unsent',
            pendingPlanRevisionId: 'fmr_abcdefgh',
            decision: { status: 'idle' as const },
            build: null,
            discoveries: null,
            placement: DEFAULT_DESKTOP_FOREMAN_PLACEMENT,
        }
        const closed = projectOpenChange(current, false)
        expect(closed.open).toBe(false)
        expect(closed.draft).toBe('unsent')
        expect(closed.pendingPlanRevisionId).toBe('fmr_abcdefgh')
        expect(closed.decision.status).toBe('idle')
    })


})

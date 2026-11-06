/** Explicit plan decisions — matches I's DesktopForemanDecisionInput / Decision states. */

import type { DesktopForemanChatRef, DesktopForemanLiveScope } from './identity'
import { acceptsForemanReply } from './identity'

export type DesktopPlanDecisionKind = 'confirm' | 'ask_changes'

/** Presentation mirror of DesktopForemanDecisionInput. */
export type DesktopPlanDecisionRequest =
    | {
          decision: 'confirm'
          requestId: string
          chat: DesktopForemanChatRef
          planId: string
          revisionId: string
          digest: string
      }
    | {
          decision: 'ask_changes'
          requestId: string
          chat: DesktopForemanChatRef
          planId: string
          revisionId: string
          digest: string
          feedback: string
      }

export type DesktopPlanDecisionStatus =
    | { status: 'idle' }
    | { status: 'pending'; request: DesktopPlanDecisionRequest; startedAt: number }
    | { status: 'acknowledged'; request: DesktopPlanDecisionRequest; decisionId: string; at: number }
    | { status: 'failed'; request: DesktopPlanDecisionRequest; error: string; at: number }
    | { status: 'uncertain'; request: DesktopPlanDecisionRequest; error: string; at: number }

export type DesktopPlanDecisionResult =
    | { ok: true; requestId: string; revisionId: string; decisionId: string }
    | { ok: false; requestId: string; revisionId: string; error: string; uncertain?: boolean }

export function createPlanDecisionRequestId(): string {
    if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID()
    return '00000000-0000-4000-8000-000000000000'
}

export function canSubmitPlanDecision(state: DesktopPlanDecisionStatus): boolean {
    return state.status === 'idle' || state.status === 'failed' || state.status === 'uncertain'
}

export function projectDecisionBusy(state: DesktopPlanDecisionStatus): boolean {
    return state.status === 'pending'
}

export function beginPlanDecision(state: DesktopPlanDecisionStatus, request: DesktopPlanDecisionRequest, now = Date.now()): DesktopPlanDecisionStatus {
    if (!canSubmitPlanDecision(state)) return state
    return { status: 'pending', request, startedAt: now }
}

export function applyPlanDecisionResult(
    state: DesktopPlanDecisionStatus,
    live: DesktopForemanLiveScope,
    result: DesktopPlanDecisionResult,
    now = Date.now(),
): DesktopPlanDecisionStatus {
    if (state.status !== 'pending') return state
    if (state.request.requestId !== result.requestId) return state
    if (!acceptsForemanReply(live, {
        workspaceId: state.request.chat.workspaceId,
        chatId: state.request.chat.chatId,
        runId: live.runId,
        planRevisionId: state.request.revisionId,
    })) {
        return { status: 'uncertain', request: state.request, error: 'Chat or plan revision changed before acknowledgement.', at: now }
    }
    if (result.revisionId !== state.request.revisionId) {
        return { status: 'uncertain', request: state.request, error: 'Acknowledgement named a different plan revision.', at: now }
    }
    if (result.ok) return { status: 'acknowledged', request: state.request, decisionId: result.decisionId, at: now }
    if (result.uncertain) return { status: 'uncertain', request: state.request, error: result.error, at: now }
    return { status: 'failed', request: state.request, error: result.error, at: now }
}

export function retryPlanDecisionRequest(state: DesktopPlanDecisionStatus): DesktopPlanDecisionRequest | null {
    if (state.status !== 'failed' && state.status !== 'uncertain') return null
    return state.request
}

export function clearPlanDecision(state: DesktopPlanDecisionStatus): DesktopPlanDecisionStatus {
    if (state.status === 'pending') return state
    return { status: 'idle' }
}

/** Closing / switching tabs must not confirm. */
export function tabChangePreservesDecision(state: DesktopPlanDecisionStatus): DesktopPlanDecisionStatus {
    return state
}

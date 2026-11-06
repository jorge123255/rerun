import type { DesktopTriggerHistoryItem, DesktopTriggerDeliveryStatus } from '@rerun/contracts'
import type { TriggerRequestLink, TriggerRequestView } from './types'

export function triggerRequestStatus(view: TriggerRequestView): string {
    if (view.phase === 'stop-uncertain') return 'Stop acknowledgement unknown'
    if (view.phase === 'stopped' || view.runStatus === 'cancelled' || view.availability === 'stopped') return 'Stopped'
    if (view.phase === 'uncertain') return 'Response acknowledgement unknown'
    if (view.phase === 'accepted') return 'Response sent'
    if (view.runStatus === 'error') return 'Run failed'
    if (view.runStatus === 'running') return 'Working…'
    if (view.availability === 'superseded' || view.phase === 'superseded') return 'Request no longer current'
    if (view.availability !== 'ready') return 'Request unavailable'
    return view.request ? 'Needs your attention' : 'No pending request confirmed'
}
export function triggerRequestMetadata(link: TriggerRequestLink) {
    return { source: 'trigger' as const, triggerSlug: link.slug, eventId: link.eventId, runId: link.triggerRunId,
        sourceRunId: link.sourceRunId, requestId: link.requestId, requestKind: link.kind,
        agentId: link.agentId, sessionId: link.sessionId }
}
export function decorateTriggerAttention<T extends { id: string; kind: string; agentId: string; sessionId: string }>(item: T, view: TriggerRequestView): (T & { trigger: ReturnType<typeof triggerRequestMetadata> }) | null {
    const link = view.link
    if (item.id !== link.requestId || item.kind !== link.kind || item.agentId !== link.agentId || item.sessionId !== link.sessionId || view.phase === 'accepted' || view.phase === 'stopped' || view.phase === 'superseded') return null
    return { ...item, trigger: triggerRequestMetadata(link) }
}
export function triggerResultTarget(link: TriggerRequestLink) {
    return { workspaceId: link.workspaceId, agentId: link.agentId, engineAgentId: link.engineAgentId, sessionId: link.sessionId,
        engineSessionId: link.engineSessionId, runId: link.triggerRunId, tabUid: `trigger:${link.sessionId}`,
        eventId: link.eventId, requestId: link.requestId }
}
export function sameTriggerResultOwner(a: TriggerRequestLink, b: TriggerRequestLink) {
    return a.workspaceId === b.workspaceId && a.agentId === b.agentId && a.engineAgentId === b.engineAgentId
        && a.sessionId === b.sessionId && a.engineSessionId === b.engineSessionId && a.eventId === b.eventId
        && a.triggerRunId === b.triggerRunId && a.sourceRunId === b.sourceRunId && a.requestId === b.requestId
        && a.kind === b.kind && a.toolCallId === b.toolCallId && a.sourceMessageId === b.sourceMessageId && a.fingerprint === b.fingerprint
}

export function projectTriggerEventOutcome(event: DesktopTriggerHistoryItem, views: readonly TriggerRequestView[], current: {
    continuation: { id: string; status: 'running' | 'done' | 'error' | 'cancelled' } | null
    pendingChecked: boolean
}): { status: DesktopTriggerDeliveryStatus; canNotifyDone: boolean; attentionRequestIds: string[] } {
    const exact = views.filter(view => view.link.eventId === event.eventId && view.link.sessionId === event.localSessionId && view.link.triggerRunId === event.runId)
    const pending = exact.filter(view => view.phase !== 'accepted' && view.phase !== 'stopped' && view.phase !== 'superseded')
    if (pending.some(view => view.phase === 'uncertain' || view.phase === 'stop-uncertain')) return { status: 'uncertain', canNotifyDone: false, attentionRequestIds: pending.map(view => view.link.requestId) }
    if (pending.length) return { status: pending.some(view => view.runStatus === 'error') ? 'error' : 'needs-input', canNotifyDone: false, attentionRequestIds: pending.map(view => view.link.requestId) }
    const accepted = exact.filter(view => view.phase === 'accepted' && view.acceptedRunId)
    if (accepted.length) {
        const leaves = accepted.filter(view => !accepted.some(other => other.link.sourceRunId === view.acceptedRunId))
        if (leaves.length !== 1) return { status: 'uncertain', canNotifyDone: false, attentionRequestIds: [] }
        const last = leaves[0]
        if (!current.continuation || current.continuation.id !== last.acceptedRunId || !current.pendingChecked) return { status: 'uncertain', canNotifyDone: false, attentionRequestIds: [] }
        const status = current.continuation.status === 'done' ? 'finished' : current.continuation.status === 'error' ? 'error' : current.continuation.status === 'cancelled' ? 'cancelled' : 'running'
        return { status, canNotifyDone: status === 'finished', attentionRequestIds: [] }
    }
    const status = event.status === 'needs-input' ? 'uncertain' : event.status
    return { status, canNotifyDone: status === 'finished' && current.pendingChecked, attentionRequestIds: [] }
}

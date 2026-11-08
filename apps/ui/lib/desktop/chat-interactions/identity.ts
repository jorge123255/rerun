import type { DesktopWorkspaceId } from '@rerun/contracts'
export type ChatInteractionIdentity = {
    workspaceId: DesktopWorkspaceId; agentId: string; sessionId: string; tabUid: string
    messageId: string; toolCallId?: string; sourceFingerprint: string
}
export function interactionKey(value: ChatInteractionIdentity): string {
    return JSON.stringify([value.workspaceId, value.agentId, value.sessionId, value.tabUid, value.messageId, value.toolCallId ?? null, value.sourceFingerprint])
}
export function sameInteraction(a: ChatInteractionIdentity, b: ChatInteractionIdentity | null): boolean {
    return !!b && interactionKey(a) === interactionKey(b)
}

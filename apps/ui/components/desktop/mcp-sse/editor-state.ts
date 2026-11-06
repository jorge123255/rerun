import type { DesktopMcpSseConfiguration, DesktopMcpSseRef, DesktopMcpSseSave, DesktopMcpSseMutationResult } from '../../../../../packages/contracts/src/desktop-mcp-sse'
import { desktopMcpSseConfigurationSchema } from '../../../../../packages/contracts/src/desktop-mcp-sse'
import { endpoint } from '@/lib/desktop/server/mcp/model'

export type SseEditorAttempt = { kind: 'save'; change: DesktopMcpSseSave } | { kind: 'delete'; requestId: string; reference: DesktopMcpSseRef }
export type SseEditorDriver = {
    journal: {
        read(slot: string, signal: AbortSignal): Promise<SseEditorAttempt | null>
        put(slot: string, attempt: SseEditorAttempt, signal: AbortSignal): Promise<void>
        clear(slot: string, requestId: string, signal: AbortSignal): Promise<void>
    }
    save(change: DesktopMcpSseSave, signal: AbortSignal): Promise<DesktopMcpSseMutationResult>
    remove(reference: DesktopMcpSseRef, requestId: string, signal: AbortSignal): Promise<DesktopMcpSseMutationResult>
    reconcile(agentId: string, requestId: string, signal: AbortSignal): Promise<DesktopMcpSseMutationResult>
}
export function sseEditorConfiguration(name: string, url: string): DesktopMcpSseConfiguration {
    return desktopMcpSseConfigurationSchema.parse({ name: name.trim(), transport: 'sse', url: endpoint(url.trim()) })
}
export function sseEditorSlot(agentId: string, serverId?: string) { return JSON.stringify(['mcp-sse-editor', agentId, serverId ?? 'new']) }
export function sseAttemptId(attempt: SseEditorAttempt) { return attempt.kind === 'save' ? attempt.change.requestId : attempt.requestId }
export function sameSseEditorAttempt(attempt: SseEditorAttempt, agentId: string, reference?: DesktopMcpSseRef) {
    return attempt.kind === 'save'
        ? attempt.change.agentId === agentId && attempt.change.serverId === (reference?.serverId ?? null) && attempt.change.expectedRevision === (reference?.expectedRevision ?? null)
        : !!reference && attempt.reference.agentId === agentId && attempt.reference.serverId === reference.serverId && attempt.reference.name === reference.name && attempt.reference.expectedRevision === reference.expectedRevision
}
export function sameSseEditorOwner(attempt: SseEditorAttempt, agentId: string, reference?: DesktopMcpSseRef) {
    return attempt.kind === 'save'
        ? attempt.change.agentId === agentId && attempt.change.serverId === (reference?.serverId ?? null)
        : !!reference && attempt.reference.agentId === agentId && attempt.reference.serverId === reference.serverId && attempt.reference.name === reference.name
}

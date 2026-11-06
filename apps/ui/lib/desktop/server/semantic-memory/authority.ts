import type { DesktopSemanticIndexStatus, DesktopSemanticRecallRequest, DesktopSemanticRecallResult } from '@rerun/contracts'

// Root binds this at process start. An unbound authority is keyword-only. It does not open a second note store.
export type DesktopSemanticMemoryAuthority = {
    recall(localAgentId: string, request: DesktopSemanticRecallRequest, signal?: AbortSignal): Promise<DesktopSemanticRecallResult>
    status(localAgentId: string, signal?: AbortSignal): Promise<DesktopSemanticIndexStatus>
    maintain?(localAgentId: string, operation: 'retry' | 'reconcile', signal?: AbortSignal): Promise<DesktopSemanticIndexStatus>
}

let bound: DesktopSemanticMemoryAuthority | null = null

export function bindDesktopSemanticMemoryAuthority(next: DesktopSemanticMemoryAuthority | null) {
    bound = next
}

export function desktopSemanticMemoryAuthority(): DesktopSemanticMemoryAuthority | null {
    return bound
}

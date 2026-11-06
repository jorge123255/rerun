import type { SharedMutationCall } from '@rerun/contracts'

// Root supplies the current workspace from the canonical workspace selection.
// This module does not read catalog.json and does not invent a second catalog.

export type SharedMutationOwnerState = 'active' | 'deleted' | 'disabled' | 'replaced'

export type SharedMutationAuthority = {
    current(input: Pick<SharedMutationCall, 'engineAgentId' | 'workspaceId' | 'sessionId' | 'runId' | 'toolCallId'>, signal: AbortSignal): Promise<{
        workspaceId: number
        owner: string
        sharedRoot: string
        dataRoot: string
        launchNonce: string
        state: SharedMutationOwnerState
        writeGrant: boolean
    }>
}

export class SharedMutationRefusal extends Error {
    constructor(readonly code: 'workspace_unbound' | 'stale_workspace' | 'root_replaced' | 'owner_deleted' | 'owner_disabled' | 'owner_replaced' | 'grant' | 'closed', message: string) {
        super(message)
        this.name = 'SharedMutationRefusal'
    }
}
export type SharedMutationCallInput = SharedMutationCall

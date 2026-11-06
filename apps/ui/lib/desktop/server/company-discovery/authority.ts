import type { CompanyDiscoveryEvent, CompanyDiscoverySource } from '@rerun/contracts'

// Root supplies both. A missing authority fails closed: no fetch, no invented company.

export type CompanyDiscoveryOwner = 'active' | 'deleted' | 'disabled' | 'replaced'

export type CompanyDiscoveryAuthority = {
    currentWorkspaceId(): Promise<string>
    // Must not read browsing history, account cookies or ambient credentials.
    assertRun(input: { workspaceId: string; chatId: string; runId: string; discoveryId: string }, signal: AbortSignal): Promise<void>
    owner(input: { workspaceId: string; chatId: string }): Promise<CompanyDiscoveryOwner>
}

export type CompanyDiscoveryRunner = (input: {
    url: string
    signal: AbortSignal
    now: () => Date
    assertCurrent(): Promise<void>
    revisions: Partial<Record<CompanyDiscoverySource, number>>
    emit: (event: CompanyDiscoveryEvent) => void
}) => Promise<void>

export class CompanyDiscoveryError extends Error {
    constructor(
        readonly code:
            | 'authority_unbound'
            | 'fetch_authority_unbound'
            | 'binding_unbound'
            | 'stale_workspace'
            | 'stale_run'
            | 'owner_deleted'
            | 'owner_disabled'
            | 'owner_replaced'
            | 'not_found'
            | 'conflict'
            | 'private_target'
            | 'closed'
            | 'cancelled',
        message: string,
    ) {
        super(message)
        this.name = 'CompanyDiscoveryError'
    }
}

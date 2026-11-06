import type { ExternalMcpWorkspaceId } from '@rerun/contracts'

/** Live desktop runtime. A null read means root has not bound workspace identity. */
export type ExternalMcpRuntimeSnapshot = {
    installId: string
    launchNonce: string
    workspaceId: ExternalMcpWorkspaceId
    admissionsFrozen: boolean
    stopping: boolean
}

export type ExternalMcpRuntimeAuthority = {
    read(): ExternalMcpRuntimeSnapshot | null
}

const unbound: ExternalMcpRuntimeAuthority = { read: () => null }
let current: ExternalMcpRuntimeAuthority = unbound

export function bindExternalMcpRuntimeAuthority(authority: ExternalMcpRuntimeAuthority): void {
    current = authority
}

export function readExternalMcpRuntimeAuthority(): ExternalMcpRuntimeAuthority {
    return current
}

export const EXTERNAL_MCP_RUNTIME_AUTHORITY = 'ExternalMcpRuntimeAuthority'

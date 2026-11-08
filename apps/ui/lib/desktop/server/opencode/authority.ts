// Root binds this from the encrypted connection. The key is already decrypted.
// This module does not read the keychain, a catalog file, or process.env.

export type DesktopOpencodeConnectionState = 'active' | 'deleted' | 'disabled' | 'replaced'

export type DesktopOpencodeAuthoritySnapshot = {
    workspaceId: number
    owner: string
    connectionId: string
    connectionRevision: string
    apiKey: string | null
    consoleEnabled: boolean
    enabledModelIds: string[]
    defaultModelId: string
    state: DesktopOpencodeConnectionState
    launchNonce: string
}

export type DesktopOpencodeAuthority = {
    current(input: { workspaceId: number; connectionId: string }, signal?: AbortSignal): Promise<DesktopOpencodeAuthoritySnapshot | null>
}

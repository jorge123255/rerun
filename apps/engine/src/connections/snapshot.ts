import { DESKTOP_OPENCODE_CONNECTION_ID, parseDesktopSubscriptionConnectionId } from '@rerun/contracts'
import type { LoadedConnection } from './types.js'

// OpenCode is projected from the workspace's encrypted settings on every registry read.
export function sameDesktopOpencodeConnection(expected: LoadedConnection, current: LoadedConnection): boolean {
    return expected.id === DESKTOP_OPENCODE_CONNECTION_ID && current.id === expected.id &&
        expected.config.provider === 'opencode' && current.config.provider === 'opencode' &&
        !!expected.opencode && !!current.opencode &&
        expected.opencode.workspaceId === current.opencode.workspaceId && expected.opencode.revision === current.opencode.revision
}

export function sameConnectionSnapshot(expected: LoadedConnection, current: LoadedConnection): boolean {
    if (current.id !== expected.id || current.config.provider !== expected.config.provider) return false
    if (expected.opencode) return sameDesktopOpencodeConnection(expected, current)
    if (expected.custom) return current.custom?.revision === expected.custom.revision
    // Subscription connection IDs include the credential generation.
    return current === expected || parseDesktopSubscriptionConnectionId(expected.id)?.provider === expected.config.provider
}

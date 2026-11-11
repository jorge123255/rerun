import { DESKTOP_OPENCODE_CONNECTION_ID } from '@rerun/contracts'
import type { LoadedConnection } from './types.js'

// OpenCode is projected from the workspace's encrypted settings on every registry read.
export function sameDesktopOpencodeConnection(expected: LoadedConnection, current: LoadedConnection): boolean {
    return expected.id === DESKTOP_OPENCODE_CONNECTION_ID && current.id === expected.id &&
        expected.config.provider === 'opencode' && current.config.provider === 'opencode' &&
        !!expected.opencode && !!current.opencode &&
        expected.opencode.workspaceId === current.opencode.workspaceId && expected.opencode.revision === current.opencode.revision
}

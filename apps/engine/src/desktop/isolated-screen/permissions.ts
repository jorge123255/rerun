import type { AgentConfig } from '@rerun/contracts'
import { readAgentConfig } from '../../agents/loader.js'
import { desktopDeletionActive } from '../agent-lifecycle.js'
import { hasDesktopToolGrant } from '../tool-grants.js'
import type { ScreenTarget } from './types.js'

export type ScreenForeground = 'browser' | 'terminal' | 'files' | 'unknown'
const grants = ['browser', 'computer', 'terminalLaunch', 'filesLaunch', 'toolInstall'] as const
export function screenGranted(config: AgentConfig) {
    return config.enabled && hasDesktopToolGrant(config, 'computer') && (hasDesktopToolGrant(config, 'browser') || hasDesktopToolGrant(config, 'terminalLaunch') || hasDesktopToolGrant(config, 'filesLaunch'))
}
export function screenPermissionsRevoked(before: AgentConfig, after: AgentConfig) {
    return !screenGranted(after) || grants.some(grant => hasDesktopToolGrant(before, grant) && !hasDesktopToolGrant(after, grant))
}
export async function authorizeScreenInput(target: ScreenTarget, app: ScreenForeground, signal: AbortSignal) {
    signal.throwIfAborted()
    const current = await readAgentConfig(target.engineAgentId)
    signal.throwIfAborted()
    if (desktopDeletionActive(target.engineAgentId) || !screenGranted(current) || app === 'unknown') throw new Error('The foreground app is not authorized')
    const grant = app === 'terminal' ? 'terminalLaunch' : app === 'files' ? 'filesLaunch' : 'browser'
    if (!hasDesktopToolGrant(current, grant)) throw new Error('Enable permission for the app in front')
}

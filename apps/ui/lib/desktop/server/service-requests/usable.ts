import type { DesktopServiceHealth } from '@rerun/contracts'

export type DesktopServiceAuthoritySnapshot = { engineAgentId: string; enabled: boolean; granted: boolean; launchNonce: string }

// Same read-only predicate as localServiceLifecycle view(). This does not probe, save, or enable Apps.
export function desktopServiceConnectionUsable(input: {
    engineId: string
    state: string
    health: DesktopServiceHealth
    healthLaunch: string | null
    authority: DesktopServiceAuthoritySnapshot
    now: number
}): boolean {
    const checkedAt = Date.parse(input.health.checkedAt ?? '')
    return input.authority.engineAgentId === input.engineId
        && input.state === 'ready'
        && input.authority.enabled
        && input.authority.granted
        && input.health.state === 'healthy'
        && input.healthLaunch === input.authority.launchNonce
        && Number.isFinite(checkedAt)
        && input.now >= checkedAt
        && input.now - checkedAt < 60_000
}

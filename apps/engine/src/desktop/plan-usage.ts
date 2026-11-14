import { isDesktopSubscriptionProvider } from '@rerun/contracts'
import { CLAUDE_HARNESS_ENV } from '../agents/providers.js'
import type { LoadedConnection } from '../connections/types.js'
import { refreshStaleDesktopClaudePlanLimits } from './claude-plan/usage.js'
import { desktopApp } from './policy.js'
import { refreshDesktopSubscriptionPlanUsage } from './subscription-acp/runtime.js'

/**
 * The plans that say how much of them is used but only when asked: Claude and Grok. Called where
 * the connections are listed; the caller answers with the reading it has and the fresh one is
 * there for the next ask, as with ChatGPT.
 */
export function refreshStaleDesktopPlanUsage(connections: readonly LoadedConnection[]): void {
    if (!desktopApp()) return
    for (const connection of connections) {
        const provider = connection.config.provider
        if (provider === 'claude') void refreshStaleDesktopClaudePlanLimits(connection, CLAUDE_HARNESS_ENV)
        else if (isDesktopSubscriptionProvider(provider)) void refreshDesktopSubscriptionPlanUsage(provider)
    }
}

import { isDesktopSubscriptionProvider } from '@rerun/contracts'
import type { LoadedConnection } from '../connections/types.js'
import { desktopApp } from './policy.js'
import { refreshDesktopSubscriptionPlanUsage } from './subscription-acp/runtime.js'

/**
 * The plans that say how much of them is used when asked: Grok, and Kimi while its sign-in is
 * fresh. Called where the connections are listed; the caller answers with the reading it has and
 * the fresh one is there for the next ask, as with ChatGPT.
 *
 * Claude is deliberately absent. Its limits come from the message its own runner sends while it
 * answers; the engine never asks Anthropic's usage endpoint itself (owner's decision, November 14,
 * 2026: the endpoint throttles such requests and the account is not worth risking for a gauge).
 */
export function refreshStaleDesktopPlanUsage(connections: readonly LoadedConnection[]): void {
    if (!desktopApp()) return
    for (const connection of connections) {
        const provider = connection.config.provider
        if (isDesktopSubscriptionProvider(provider)) void refreshDesktopSubscriptionPlanUsage(provider)
    }
}

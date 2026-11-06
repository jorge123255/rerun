import { DESKTOP_CHATGPT_CONNECTION_ID, DESKTOP_CLAUDE_SUBSCRIPTION_CONNECTION_ID, type DesktopSubscriptionAdapterCapability, type DesktopSubscriptionProfileProvider } from './contract.js'

/** Source-backed limits. Neither desktop adapter opens a second authenticated subscription session. */
export const subscriptionAdapterCapabilities: Record<DesktopSubscriptionProfileProvider, DesktopSubscriptionAdapterCapability> = {
    chatgpt: {
        provider: 'chatgpt',
        canonicalConnectionId: DESKTOP_CHATGPT_CONNECTION_ID,
        independentSessions: false,
        maxAuthenticatedSessions: 1,
        additionalProfileExecution: 'blocked',
        reason: 'ChatGPT on this desktop uses the one mac-chatgpt connection and one profile directory. A second subscription cannot run.',
    },
    claude: {
        provider: 'claude',
        canonicalConnectionId: DESKTOP_CLAUDE_SUBSCRIPTION_CONNECTION_ID,
        independentSessions: false,
        maxAuthenticatedSessions: 1,
        additionalProfileExecution: 'blocked',
        reason: 'Claude on this desktop accepts only the mac-claude connection and its one token. A spawn directory is a sandbox, not another account.',
    },
}

export const builtinSubscriptionProfile = {
    chatgpt: { profileId: 'spr_builtin_chatgpt' as const, connectionId: DESKTOP_CHATGPT_CONNECTION_ID, displayName: 'ChatGPT' },
    claude: { profileId: 'spr_builtin_claude' as const, connectionId: DESKTOP_CLAUDE_SUBSCRIPTION_CONNECTION_ID, displayName: 'Claude' },
}

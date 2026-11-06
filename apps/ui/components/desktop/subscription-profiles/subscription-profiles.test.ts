import { expect, test } from 'vitest'
import { subscriptionProfileChoice, subscriptionProfileLimit } from './projection'
import { createSubscriptionProfileSession } from './session'
import { SUBSCRIPTION_PROFILE_NOT_READY, SUBSCRIPTION_PROFILE_UNKNOWN, type DesktopSubscriptionProfileCatalog } from './contract'

const catalog: DesktopSubscriptionProfileCatalog = {
    version: 1,
    workspaceId: 1,
    capabilities: [
        { provider: 'chatgpt', canonicalConnectionId: 'mac-chatgpt', independentSessions: false, maxAuthenticatedSessions: 1, additionalProfileExecution: 'blocked', reason: 'ChatGPT keeps one session.' },
        { provider: 'claude', canonicalConnectionId: 'mac-claude', independentSessions: false, maxAuthenticatedSessions: 1, additionalProfileExecution: 'blocked', reason: 'Claude keeps one session.' },
    ],
    profiles: [
        { version: 1, workspaceId: 1, profileId: 'spr_builtin_chatgpt', provider: 'chatgpt', displayName: 'ChatGPT', connectionId: 'mac-chatgpt', credentialGeneration: 'rev_chatgpt01', credentialMetadataPresent: true, providerReady: false, availability: 'current-session', selectable: true, reason: 'ChatGPT keeps one session.' },
        { version: 1, workspaceId: 1, profileId: 'spr_otherchatgpt', provider: 'chatgpt', displayName: 'Other', connectionId: null, credentialGeneration: null, credentialMetadataPresent: false, providerReady: false, availability: 'unavailable', selectable: false, reason: 'ChatGPT keeps one session.' },
    ],
    explicitSelections: [],
}

test('the selector copy keeps a second profile unavailable and does not treat metadata as ready', () => {
    expect(subscriptionProfileChoice(catalog.profiles[0])).toMatchObject({ disabled: false, badge: 'Current session', providerReady: false })
    expect(subscriptionProfileChoice(catalog.profiles[0]).detail).toContain('not a signed-in session')
    expect(subscriptionProfileChoice(catalog.profiles[1])).toMatchObject({ disabled: true, badge: 'Unavailable' })
    expect(subscriptionProfileLimit(catalog)).toEqual(['ChatGPT keeps one session.', 'Claude keeps one session.'])
    expect(SUBSCRIPTION_PROFILE_NOT_READY).toContain('not a signed-in')
})

test('an uncertain profile attempt is not sent again', async () => {
    let calls = 0
    const session = createSubscriptionProfileSession({ attempt: async () => { calls += 1; return { status: 'uncertain', message: SUBSCRIPTION_PROFILE_UNKNOWN } } })
    expect(await session.once('00000000-0000-4000-8000-000000000040')).toMatchObject({ status: 'uncertain' })
    expect(await session.once('00000000-0000-4000-8000-000000000040')).toMatchObject({ status: 'uncertain' })
    expect(calls).toBe(1)
})

import { expect, test } from 'vitest'
import { SUBSCRIPTION_PROFILE_BOUND, SUBSCRIPTION_PROFILE_DRAIN, SUBSCRIPTION_PROFILE_LIMIT, SUBSCRIPTION_PROFILE_NOT_READY, SUBSCRIPTION_PROFILE_PENDING, SUBSCRIPTION_PROFILE_UNKNOWN } from './contract.js'
import { createSubscriptionProfileService, type SubscriptionProfileCustody } from './service.js'
import { SUBSCRIPTION_PROFILE_DDL, type SubscriptionProfileRow, type SubscriptionProfileStore, type SubscriptionReceiptRow, type SubscriptionRunBinding } from './store.js'

function memoryStore(): SubscriptionProfileStore {
    const profiles: SubscriptionProfileRow[] = []
    const receipts: SubscriptionReceiptRow[] = []
    const bindings: SubscriptionRunBinding[] = []
    return {
        async profiles(workspaceId) { return profiles.filter(row => row.workspaceId === workspaceId) },
        async putProfile(row) {
            const index = profiles.findIndex(item => item.workspaceId === row.workspaceId && item.profileId === row.profileId)
            if (index >= 0) profiles[index] = row
            else profiles.push(row)
        },
        async deleteProfile(workspaceId, profileId) {
            const index = profiles.findIndex(row => row.workspaceId === workspaceId && row.profileId === profileId)
            if (index >= 0) profiles.splice(index, 1)
        },
        async receipt(workspaceId, requestId) { return receipts.find(row => row.workspaceId === workspaceId && row.requestId === requestId) ?? null },
        async putReceipt(row) { receipts.push(row) },
        async binding(workspaceId, runId) { return bindings.find(row => row.workspaceId === workspaceId && row.runId === runId) ?? null },
        async bindingsForProfile(workspaceId, profileId) { return bindings.filter(row => row.workspaceId === workspaceId && row.profileId === profileId) },
        async putBinding(row) { bindings.push(row) },
    }
}

function custody(over: Partial<SubscriptionProfileCustody> = {}): SubscriptionProfileCustody & { stops: string[] } {
    const stops: string[] = []
    return {
        stops,
        workspaceId: 1,
        async pendingRuns() { return [] },
        async credentialGeneration(connectionId) { return connectionId === 'mac-chatgpt' ? 'rev_chatgpt01' : '3' },
        async credentialMetadataPresent() { return true },
        async stopAndDrain(connectionId) { stops.push(connectionId); return 'stopped' },
        ...over,
    }
}

const owner = { workspaceId: 1, ownerId: 'local-owner' }

test('the profile store does not keep a credential or a credential hash', () => {
    expect(SUBSCRIPTION_PROFILE_DDL).not.toMatch(/secret|token|hash|fingerprint|api_key/i)
})

test('metadata does not make a provider ready and a second profile cannot run', async () => {
    const port = custody()
    const service = createSubscriptionProfileService({ store: memoryStore(), custody: port, now: () => new Date('2026-11-06T00:00:00.000Z') })
    const listed = await service.catalog(1)
    expect(listed.profiles.find(profile => profile.profileId === 'spr_builtin_chatgpt')).toMatchObject({ credentialMetadataPresent: true, providerReady: false, availability: 'current-session' })
    expect(listed.capabilities.every(capability => capability.independentSessions === false && capability.maxAuthenticatedSessions === 1)).toBe(true)
    const named = await service.name({ requestId: '00000000-0000-4000-8000-000000000001', ...owner, provider: 'chatgpt', displayName: 'Other ChatGPT' })
    expect(named.receipt.status).toBe('saved')
    const after = await service.catalog(1)
    const extra = after.profiles.find(profile => profile.displayName === 'Other ChatGPT')
    expect(extra).toMatchObject({ connectionId: null, credentialGeneration: null, availability: 'unavailable', providerReady: false })
    const refused = await service.select({ requestId: '00000000-0000-4000-8000-000000000002', ...owner, profileId: extra!.profileId, expectedGeneration: null })
    expect(refused.receipt).toMatchObject({ status: 'refused', message: SUBSCRIPTION_PROFILE_LIMIT })
    expect((await service.catalog(1)).explicitSelections).toEqual([])
})

test('another workspace is refused and the builtin selection does not retarget a bound run', async () => {
    const service = createSubscriptionProfileService({ store: memoryStore(), custody: custody(), now: () => new Date('2026-11-06T00:00:00.000Z') })
    await expect(service.catalog(2)).rejects.toThrow('not in this workspace')
    const captured = await service.capture({ requestId: '00000000-0000-4000-8000-000000000010', ...owner, agentId: 'agent-1', profileId: 'spr_builtin_chatgpt', runId: 'run-1', sessionId: 'session-1' })
    expect(captured.snapshot).toMatchObject({ connectionId: 'mac-chatgpt', credentialGeneration: 'rev_chatgpt01', ownerId: 'local-owner', agentId: 'agent-1' })
    await service.recordGeneration({ requestId: '00000000-0000-4000-8000-000000000011', workspaceId: 1, connectionId: 'mac-chatgpt', credentialGeneration: 'rev_chatgpt02' })
    await expect(service.admit(captured.snapshot!)).rejects.toThrow(SUBSCRIPTION_PROFILE_BOUND)
    const replaced = await service.capture({ requestId: '00000000-0000-4000-8000-000000000012', ...owner, agentId: 'agent-1', profileId: 'spr_builtin_claude', runId: 'run-1', sessionId: 'session-1' })
    expect(replaced.receipt.message).toBe(SUBSCRIPTION_PROFILE_BOUND)
})

test('removal respects pending runs and does not retry an uncertain stop', async () => {
    let stops = 0
    const blocked = custody({ async pendingRuns() { return [{ runId: 'run-9', sessionId: 'session-9', connectionId: 'mac-claude', connectionRevision: '3', status: 'running' }] } })
    const service = createSubscriptionProfileService({ store: memoryStore(), custody: blocked, now: () => new Date('2026-11-06T00:00:00.000Z') })
    const pending = await service.remove({ requestId: '00000000-0000-4000-8000-000000000020', ...owner, profileId: 'spr_builtin_claude', expectedGeneration: '3' })
    expect(pending.receipt.message).toBe(SUBSCRIPTION_PROFILE_PENDING)
    expect(blocked.stops).toEqual([])
    const undrained = createSubscriptionProfileService({ store: memoryStore(), custody: custody({ stopAndDrain: undefined }), now: () => new Date('2026-11-06T00:00:00.000Z') })
    expect((await undrained.remove({ requestId: '00000000-0000-4000-8000-000000000021', ...owner, profileId: 'spr_builtin_chatgpt', expectedGeneration: 'rev_chatgpt01' })).receipt.message).toBe(SUBSCRIPTION_PROFILE_DRAIN)
    const uncertainPort = custody({ async stopAndDrain() { stops += 1; return 'unknown' } })
    const uncertain = createSubscriptionProfileService({ store: memoryStore(), custody: uncertainPort, now: () => new Date('2026-11-06T00:00:00.000Z') })
    const requestId = '00000000-0000-4000-8000-000000000022'
    expect((await uncertain.remove({ requestId, ...owner, profileId: 'spr_builtin_chatgpt', expectedGeneration: 'rev_chatgpt01' })).receipt).toMatchObject({ status: 'uncertain', message: SUBSCRIPTION_PROFILE_UNKNOWN })
    expect((await uncertain.remove({ requestId, ...owner, profileId: 'spr_builtin_chatgpt', expectedGeneration: 'rev_chatgpt01' })).receipt.status).toBe('uncertain')
    expect(stops).toBe(1)
})

test('a profile without a credential generation cannot start a bound run', async () => {
    const service = createSubscriptionProfileService({ store: memoryStore(), custody: custody({ async credentialGeneration() { return null } }), now: () => new Date('2026-11-06T00:00:00.000Z') })
    const result = await service.capture({ requestId: '00000000-0000-4000-8000-000000000030', ...owner, agentId: 'agent-1', profileId: 'spr_builtin_chatgpt', runId: 'run-2', sessionId: 'session-2' })
    expect(result.receipt).toMatchObject({ status: 'refused', message: SUBSCRIPTION_PROFILE_NOT_READY })
    expect(result.snapshot).toBeUndefined()
})

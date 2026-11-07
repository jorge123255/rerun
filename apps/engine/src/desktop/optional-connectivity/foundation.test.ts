import { describe, expect, it, vi } from 'vitest'
import { REMOTE_GATEWAY_APPROVED_READS } from './contract.js'
import { createOptionalConnectivityFoundation } from './index.js'
import { createIncomingWebhookAdmission } from './incoming-webhook.js'
import { createPublicSharePolicy, shareSelectionIsExplicit } from './public-share.js'
import { createRemoteGatewayAdmission } from './remote-gateway.js'
import * as published from '../../../../../packages/contracts/src/desktop-optional-connectivity.ts'

const actor = { installId: '11111111-1111-4111-8111-111111111111', workspaceId: 1, launchNonce: '22222222-2222-4222-8222-222222222222', rendererEpoch: '33333333-3333-4333-8333-333333333333' }
const identity = { protocolVersion: 1 as const, machineId: '44444444-4444-4444-8444-444444444444', workspaceId: 1 }
const grant = { grantId: '55555555-5555-4555-8555-555555555555', actor, identity, expiresAt: '2026-11-07T00:00:00.000Z', revoked: false }
const snapshot = {
    version: 1 as const,
    actor,
    revision: '66666666-6666-4666-8666-666666666666',
    selected: true,
    runtimeState: 'connected' as const,
    connection: {
        connectionId: '77777777-7777-4777-8777-777777777777',
        revision: '66666666-6666-4666-8666-666666666666',
        workspaceId: 1,
        address: 'https://server.example',
        identity,
        credentialConfigured: true as const,
        removable: true as const,
        health: { state: 'connected' as const, checkedAt: '2026-11-06T00:00:00.000Z', commit: null, activeAgents: 0, reason: null },
    },
    activeReceipt: null,
    openReceipt: null,
}

describe('optional connectivity foundation', () => {
    it('matches the unpublished contract and stays disabled by default', async () => {
        expect(published.REMOTE_GATEWAY_APPROVED_READS).toEqual(REMOTE_GATEWAY_APPROVED_READS)
        const foundation = createOptionalConnectivityFoundation()
        expect(foundation.activation).toEqual({ remoteGateway: false, publicShare: false, incomingWebhook: false })
        const signal = new AbortController().signal
        expect(await foundation.remote.admit({ enabled: false, capabilityApproved: true, actor, grant, now: '2026-11-06T00:00:00.000Z' }, signal)).toMatchObject({ outcome: 'disabled', connected: false })
        expect(foundation.share.project({ enabled: false, callerId: 'owner', proofId: 'owner', grant: null, items: [], now: '2026-11-06T00:00:00.000Z' }).outcome).toBe('refused')
        expect((await foundation.webhook.admit({ enabled: false, scheme: 'token', workspaceId: 1, targetId: 'hook', eventKey: 'evt', fire: { token: 'x', method: 'POST' }, signal })).outcome).toBe('disabled')
    })

    it('admits a remote policy only for the same principal and never claims a connection', async () => {
        const read = vi.fn(async () => snapshot)
        const gateway = createRemoteGatewayAdmission({ read })
        const now = '2026-11-06T00:00:00.000Z'
        const signal = new AbortController().signal
        expect(await gateway.admit({ enabled: true, capabilityApproved: false, actor, grant, now }, signal)).toMatchObject({ outcome: 'unavailable', connected: false, grantsTools: false })
        expect(await gateway.admit({ enabled: true, capabilityApproved: true, actor, grant: null, now }, signal)).toMatchObject({ outcome: 'unavailable' })
        expect(await gateway.admit({ enabled: true, capabilityApproved: true, actor, grant, now }, signal)).toMatchObject({ outcome: 'admitted', connected: false, machineId: identity.machineId })
        expect(read).toHaveBeenCalledTimes(1)
        expect(await gateway.admit({ enabled: true, capabilityApproved: true, actor, grant: gateway.revoke(grant), now }, signal)).toMatchObject({ outcome: 'revoked' })
        expect(await gateway.admit({ enabled: true, capabilityApproved: true, actor, grant, now: grant.expiresAt }, signal)).toMatchObject({ outcome: 'expired' })
        const missing = createRemoteGatewayAdmission({ read: async () => null })
        expect(await missing.admit({ enabled: true, capabilityApproved: true, actor, grant, now }, signal)).toMatchObject({ outcome: 'no-host', connected: false })
        const broken = createRemoteGatewayAdmission({ read: async () => { throw new Error('store') } })
        expect(await broken.admit({ enabled: true, capabilityApproved: true, actor, grant, now }, signal)).toMatchObject({ outcome: 'uncertain' })
    })

    it('projects only the explicitly selected share items and keeps secrets out of the audit', () => {
        expect(shareSelectionIsExplicit({})).toBe(true)
        expect(shareSelectionIsExplicit({ memories: true })).toBe(false)
        const policy = createPublicSharePolicy()
        const item = { id: '88888888-8888-4888-8888-888888888888', path: 'workspace/note.md', kind: 'text' as const }
        const hidden = { id: '99999999-9999-4999-8999-999999999999', path: 'memory/secret.md', kind: 'text' as const }
        const shareGrant = { grantId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', subjectId: 'owner', workspaceId: 1, itemIds: [item.id, hidden.id], expiresAt: '2026-11-07T00:00:00.000Z', revoked: false }
        const issued = policy.issue(shareGrant, true)
        const projected = policy.project({ enabled: true, callerId: 'owner', proofId: 'owner', grant: issued.grant, items: [item, hidden, { ...item, id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }], now: '2026-11-06T00:00:00.000Z' })
        expect(projected.items).toEqual([item])
        expect(JSON.stringify(projected.audit)).not.toMatch(/secret|token|authorization/i)
        expect(policy.project({ enabled: true, callerId: 'owner', proofId: 'other', grant: issued.grant, items: [item], now: '2026-11-06T00:00:00.000Z' }).outcome).toBe('refused')
        expect(policy.project({ enabled: true, callerId: 'owner', proofId: 'owner', grant: policy.revoke(shareGrant).grant, items: [item], now: '2026-11-06T00:00:00.000Z' }).outcome).toBe('revoked')
    })

    it('authorizes one webhook delivery without scheduling, replaying, or granting tools', async () => {
        const secrets = { read: vi.fn(async () => 'correct-token') }
        const deliveries = { find: vi.fn(async () => ({ state: 'absent' as const })) }
        const admission = createIncomingWebhookAdmission({ secrets, deliveries })
        const signal = new AbortController().signal
        const fire = { token: 'correct-token', method: 'POST' as const, body: '{}', bodyBytes: 2 }
        expect(await admission.admit({ enabled: true, scheme: 'unsupported', workspaceId: 1, targetId: 'hook', eventKey: 'evt-1', fire, signal })).toMatchObject({ outcome: 'unavailable', scheduled: false })
        expect(await admission.admit({ enabled: true, scheme: 'token', workspaceId: 1, targetId: 'hook', eventKey: 'evt-1', fire: { ...fire, token: 'wrong' }, signal })).toMatchObject({ outcome: 'refused', scheduled: false })
        const ok = await admission.admit({ enabled: true, scheme: 'token', workspaceId: 1, targetId: 'hook', eventKey: 'evt-1', fire, signal })
        expect(ok).toEqual({ outcome: 'authorized', scheduled: false, grantsTools: false, replay: false })
        const replay = createIncomingWebhookAdmission({ secrets, deliveries: { find: async () => ({ state: 'known', eventId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', status: 'done' }) } })
        expect(await replay.admit({ enabled: true, scheme: 'token', workspaceId: 1, targetId: 'hook', eventKey: 'evt-1', fire, signal })).toMatchObject({ outcome: 'duplicate', replay: true, scheduled: false })
        const unknown = createIncomingWebhookAdmission({ secrets, deliveries: { find: async () => ({ state: 'unknown' }) } })
        expect(await unknown.admit({ enabled: true, scheme: 'token', workspaceId: 1, targetId: 'hook', eventKey: 'evt-1', fire, signal })).toMatchObject({ outcome: 'uncertain', scheduled: false })
        const missing = createIncomingWebhookAdmission({ secrets: { read: async () => null }, deliveries })
        expect(await missing.admit({ enabled: true, scheme: 'token', workspaceId: 1, targetId: 'hook', eventKey: 'evt-2', fire, signal })).toMatchObject({ outcome: 'unavailable' })
        const stopped = new AbortController()
        stopped.abort()
        expect((await admission.admit({ enabled: true, scheme: 'token', workspaceId: 1, targetId: 'hook', eventKey: 'evt-3', fire, signal: stopped.signal })).outcome).toBe('cancelled')
    })
})

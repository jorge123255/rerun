// Synthetic offline fixtures only. No transport, native workspace, Keychain or provider is opened.
import { randomUUID, createCipheriv, createDecipheriv } from 'node:crypto'
import { createSafeStorageCustody } from './credentials.mjs'
import { createRemoteMachineCoordinator } from './coordinator.mjs'
import { publicConnection, publicReceipt, sameIdentity, refusal } from './protocol.mjs'
export const FIXTURE_KEY = 'synthetic-offline-server-key-000000000000'
export const actor = { installId: '00000000-0000-4000-8000-000000000001', workspaceId: 1,
    launchNonce: '00000000-0000-4000-8000-000000000002', rendererEpoch: '00000000-0000-4000-8000-000000000003' }
export const remoteIdentity = { protocolVersion: 1, machineId: '00000000-0000-4000-8000-000000000004', workspaceId: 7 }
export function fixtureCustody() {
    const key = Buffer.alloc(32, 7)
    return createSafeStorageCustody({ workspaceKey: () => key, safeStorage: {
        isEncryptionAvailable: () => true,
        encryptString(text) { const iv = Buffer.alloc(12, 9), cipher = createCipheriv('aes-256-gcm', key, iv); const body = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]); return Buffer.concat([iv, cipher.getAuthTag(), body]) },
        decryptString(bytes) { const cipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12)); cipher.setAuthTag(bytes.subarray(12, 28)); return Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString('utf8') },
    } })
}
export function fixture() {
    let state = { version: 1, installId: actor.installId, workspaceId: 1, revision: 'unconfigured', connection: null, selected: false, activeReceipt: null, operations: [] }
    let writes = Promise.resolve()
    const store = {
        read: async () => structuredClone(state),
        mutate(change) { const work = writes.then(async () => { const next = structuredClone(state); await change(next); next.revision = randomUUID(); state = next }); writes = work.catch(() => {}); return work },
        snapshot(value, actor) { return { version: 1, actor, revision: value.revision, connection: publicConnection(value.connection), selected: value.selected, runtimeState: 'unknown', activeReceipt: publicReceipt(value.activeReceipt ? { receipt: value.activeReceipt } : null), openReceipt: publicReceipt(value.operations.find(op => op.receipt.requiresRecovery)) } },
    }
    const effects = new Map(), calls = [], probes = [], custody = fixtureCustody()
    let lostAck = null, live = true, identity = remoteIdentity, lifetime = randomUUID()
    const ports = {
        assertAvailable() {},
        async checkActor(owner, signal) { signal.throwIfAborted(); if (!live || owner.installId !== actor.installId || owner.workspaceId !== actor.workspaceId || owner.rendererEpoch !== actor.rendererEpoch || owner.launchNonce !== actor.launchNonce) throw refusal('stale', 'Old renderer') },
        async checkOperation(ctx, signal) { signal.throwIfAborted(); if (ctx.installId !== actor.installId || ctx.workspaceId !== 1) throw refusal('stale', 'Wrong owner') },
        async lookupEffect(ctx) { return effects.has(ctx.effectId) ? { state: 'applied', receipt: effects.get(ctx.effectId) } : { state: 'not_applied' } },
        async effect(name, ctx, signal) {
            signal.throwIfAborted(); calls.push({ name, ctx })
            const value = name === 'flush' ? { saved: true } : name === 'close' ? { closed: true }
                : ['bind_remote', 'bind_local', 'verify', 'publish'].includes(name) ? { lifetimeId: lifetime, ...(ctx.target ? { identity: ctx.target } : {}) } : {}
            const receipt = { effectId: ctx.effectId, requestId: ctx.requestId, workspaceId: ctx.workspaceId, installId: ctx.installId,
                connectionId: ctx.connectionId, configurationRevision: ctx.configurationRevision, applied: true, value }
            effects.set(ctx.effectId, receipt)
            if (lostAck === name) { lostAck = null; throw refusal('uncertain', 'Synthetic lost acknowledgement') }
            return receipt
        },
    }
    const client = { async probe(input, check, signal) { await check(); signal.throwIfAborted(); probes.push(input.address)
        if (input.expectedIdentity && !sameIdentity(input.expectedIdentity, identity)) throw refusal('identity_changed', 'Different remote workspace')
        return { address: input.address, identity, tlsPin: 'a'.repeat(64), health: { state: 'connected', checkedAt: new Date().toISOString(), commit: null, activeAgents: 0, reason: null } } } }
    const create = () => createRemoteMachineCoordinator({ store, custody, client, ports })
    return { store, custody, client, ports, create, coordinator: create(), effects, calls, probes,
        state: () => state, loseAck: name => { lostAck = name }, setLive: value => { live = value }, setIdentity: value => { identity = value },
        pair: { action: 'pair', actor, requestId: randomUUID(), connectionId: randomUUID(), expectedRevision: 'unconfigured', address: 'https://machine.example', apiKey: FIXTURE_KEY } }
}

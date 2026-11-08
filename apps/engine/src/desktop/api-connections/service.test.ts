import { expect, it } from 'vitest'
import type { ConnectionUsage, CreateConnectionInput, DesktopApiPendingRun, UpdateConnectionInput, UpdateConnectionKeysInput } from '@rerun/contracts'
import type { LoadedConnection } from '../../connections/types.js'
import { createDesktopApiConnectionService, DesktopApiConnectionRefusal, desktopApiConnectionFingerprint, type DesktopApiConnectionAuthority } from './service'
import { memoryDesktopApiConnectionStore } from './store'
import { beginDesktopApiConnectionRemoval, beginDesktopApiConnectionWork, desktopApiConnectionRemovalAvailable } from './admission.js'

let sequence = 0
const ids = () => `cnx_test-${String(++sequence).padStart(8, '0')}`
const revisions = () => `rev_test-${String(++sequence).padStart(8, '0')}`
const now = () => new Date('2026-11-06T00:00:00.000Z')

function authority(): DesktopApiConnectionAuthority {
    const connections = new Map<string, LoadedConnection>()
    const pending = new Map<string, DesktopApiPendingRun[]>()
    const usages = new Map<string, ConnectionUsage>()
    let currentDefault: { connectionId: string; model: string; reasoningEffort?: string } | null = null
    return {
        workspaceId: 1,
        async list() { return [...connections.values()] },
        async get(id) { return connections.get(id) ?? null },
        async create(input, id) {
            if (connections.has(id)) throw new Error('duplicate create')
            const connection: LoadedConnection = { id, config: { name: input.name, provider: input.provider, models: input.models, extraModels: input.extraModels, baseUrl: input.baseUrl, createdAt: now().toISOString() }, env: input.keys }
            connections.set(id, connection)
            return connection
        },
        async patch(id, patch: UpdateConnectionInput) {
            const current = connections.get(id)!
            current.config = { ...current.config, ...patch }
            return current
        },
        async updateKeys(id, { set, remove }: UpdateConnectionKeysInput) {
            const current = connections.get(id)!
            for (const key of remove) delete current.env[key]
            Object.assign(current.env, set)
            return Object.keys(set).sort()
        },
        async usage(id) { return usages.get(id) ?? { agents: [], automations: [], isBoxDefault: currentDefault?.connectionId === id } },
        async release(id) {
            const usage = usages.get(id) ?? { agents: [], automations: [], isBoxDefault: currentDefault?.connectionId === id }
            for (const agent of usage.agents) usages.set(agent.id, { agents: [], automations: [], isBoxDefault: false })
            if (usage.isBoxDefault) currentDefault = null
            return usage
        },
        async delete(id) { connections.delete(id) },
        async readDefault() { return currentDefault },
        async writeDefault(next) { currentDefault = next; return next },
        async clearDefault() { currentDefault = null },
        async pendingRuns(id) { return pending.get(id) ?? [] },
        async stopAndDrain(id) { pending.set(id, []) },
        removalAvailable: () => true,
        withRemoval: async (_id, effect) => effect(),
        setPending(id, runs) { pending.set(id, runs) },
        setUsage(id, usage) { usages.set(id, usage) },
        connection(id) { return connections.get(id) },
    } as DesktopApiConnectionAuthority & { setPending(id: string, runs: DesktopApiPendingRun[]): void; setUsage(id: string, usage: ConnectionUsage): void; connection(id: string): LoadedConnection | undefined }
}

function harness() {
    const store = memoryDesktopApiConnectionStore()
    const authorityValue = authority()
    const service = createDesktopApiConnectionService({ authority: authorityValue, store, connectionId: ids, revision: revisions, now, custodyKey: () => Buffer.alloc(32, 9) })
    return { service, store, authority: authorityValue }
}
const createInput = (name: string, secret: string, requestId = crypto.randomUUID()) => ({ requestId, workspaceId: 1, provider: 'openai' as const, name, models: ['gpt-5'], extraModels: [], secret })
const pendingRun = (connectionId: string, connectionRevision: string) => ({ runId: 'run-1', sessionId: 'session-1', connectionId, connectionRevision, status: 'running' as const })

it('creates distinct siblings with redacted views and binds execution to the selected sibling', async () => {
    const { service, authority } = harness()
    const first = await service.create(createInput('OpenAI personal', 'sk-first'))
    const second = await service.create(createInput('OpenAI work', 'sk-second'))
    expect(first.connection!.connectionId).not.toBe(second.connection!.connectionId)
    expect(first.connection!.revision).not.toBe(second.connection!.revision)
    const catalog = await service.list()
    expect(catalog.connections).toHaveLength(2)
    expect(JSON.stringify(catalog)).not.toContain('sk-first')
    expect(JSON.stringify(catalog)).not.toContain('sk-second')
    const selected = await service.select({ requestId: crypto.randomUUID(), workspaceId: 1, connectionId: second.connection!.connectionId, expectedRevision: second.connection!.revision, model: 'gpt-5', source: 'workspace', runId: 'run-1', sessionId: 'session-1' })
    expect(selected.connection!.connectionId).toBe(second.connection!.connectionId)
    const snapshot = await service.executionSnapshot({ connectionId: second.connection!.connectionId, source: 'workspace', runId: 'run-1', sessionId: 'session-1', requestId: 'request-1' })
    expect(selected.connection!.revision).not.toBe(second.connection!.revision)
    expect(snapshot.connectionRevision).toBe(selected.connection!.revision)
    expect((await service.credentialForSnapshot(snapshot)).secret).toBe('sk-second')
})

it('refuses to remove the selected default model while preserving the sibling', async () => {
    const { service, authority } = harness()
    const first = await service.create(createInput('First', 'sk-first'))
    const second = await service.create(createInput('Second', 'sk-second'))
    const selected = await service.select({ requestId: crypto.randomUUID(), workspaceId: 1, connectionId: second.connection!.connectionId, expectedRevision: second.connection!.revision, model: 'gpt-5', source: 'workspace', runId: 'run-1', sessionId: 'session-1' })
    const result = await service.models({ requestId: crypto.randomUUID(), workspaceId: 1, connectionId: second.connection!.connectionId, expectedRevision: selected.connection!.revision, models: [], extraModels: [], expectedDefault: { connectionId: second.connection!.connectionId, model: 'gpt-5' } })
    expect(result.status).toBe('refused')
    expect(authority.connection(first.connection!.connectionId)!.config.models).toEqual(['gpt-5'])
    expect(authority.connection(second.connection!.connectionId)!.config.models).toEqual(['gpt-5'])
})

it('blocks removal with a pending run, then releases only that connection and its exact consequences', async () => {
    const { service, authority } = harness()
    const first = await service.create(createInput('First', 'sk-first'))
    const second = await service.create(createInput('Second', 'sk-second'))
    authority.setPending(second.connection!.connectionId, [pendingRun(second.connection!.connectionId, second.connection!.revision)])
    const blocked = await service.removalPlan(1, second.connection!.connectionId)
    expect(blocked.canRemove).toBe(false)
    expect(blocked.pendingRuns).toHaveLength(1)
    const refused = await service.remove({ requestId: crypto.randomUUID(), workspaceId: 1, connectionId: second.connection!.connectionId, expectedRevision: second.connection!.revision })
    expect(refused.status).toBe('refused')
    expect(authority.connection(first.connection!.connectionId)).toBeTruthy()
    authority.setPending(second.connection!.connectionId, [])
    authority.setUsage(second.connection!.connectionId, { agents: [{ id: 'agent-1', name: 'Agent One' }], automations: [], isBoxDefault: false })
    const removed = await service.remove({ requestId: crypto.randomUUID(), workspaceId: 1, connectionId: second.connection!.connectionId, expectedRevision: second.connection!.revision })
    expect(removed.status).toBe('saved')
    expect(removed.removal!.released.agents).toEqual([{ id: 'agent-1', name: 'Agent One' }])
    expect(removed.removal!.preservedConnectionIds).toEqual([first.connection!.connectionId])
    expect(authority.connection(first.connection!.connectionId)).toBeTruthy()
    expect(authority.connection(second.connection!.connectionId)).toBeFalsy()
})

it('reconciles the same create request without a second effect and refuses changed input', async () => {
    const { service } = harness()
    const input = createInput('Recover me', 'sk-secret')
    const first = await service.create(input)
    const second = await service.create(input)
    expect(second.recovered).toBe(true)
    expect(second.connection!.connectionId).toBe(first.connection!.connectionId)
    await expect(service.create({ ...input, name: 'Changed' })).rejects.toThrow()
})

it('returns a refused Stop before any effect', async () => {
    const { service, authority } = harness()
    const controller = new AbortController()
    controller.abort()
    const result = await service.create(createInput('Stopped', 'sk-secret'), controller.signal)
    expect(result.status).toBe('refused')
    expect(await authority.list()).toHaveLength(0)
})

it('does not rebind an old execution snapshot after credential replacement', async () => {
    const { service } = harness()
    const created = await service.create(createInput('OpenAI work', 'sk-old'))
    const snapshot = await service.executionSnapshot({ connectionId: created.connection!.connectionId, source: 'workspace', runId: 'run-1', sessionId: 'session-1', requestId: 'request-1' })
    await service.credential({ requestId: crypto.randomUUID(), workspaceId: 1, connectionId: created.connection!.connectionId, expectedRevision: created.connection!.revision, secret: 'sk-new' })
    await expect(service.credentialForSnapshot(snapshot)).rejects.toThrow()
    const next = await service.executionSnapshot({ connectionId: created.connection!.connectionId, source: 'workspace', runId: 'run-2', sessionId: 'session-1', requestId: 'request-2' })
    expect((await service.credentialForSnapshot(next)).secret).toBe('sk-new')
})

it('reconciles an ambiguous create acknowledgement without minting another connection', async () => {
    const { service, store, authority } = harness()
    let creates = 0
    const create = authority.create
    authority.create = async (input, id) => { creates++; return create(input, id) }
    let failures = 1
    const finish = store.finish
    store.finish = async (receipt, result) => { if (failures-- > 0) throw new Error('lost acknowledgement'); return finish(receipt, result) }
    const input = createInput('Ambiguous', 'sk-secret')
    expect((await service.create(input)).status).toBe('uncertain')
    expect((await service.create(input)).status).toBe('saved')
    expect(creates).toBe(1)
})

it('reconciles an ambiguous removal without releasing or deleting twice', async () => {
    const { service, store, authority } = harness()
    const created = await service.create(createInput('Remove once', 'sk-secret'))
    let deletions = 0
    const remove = authority.delete
    authority.delete = async id => { deletions++; return remove(id) }
    let failures = 1
    const finish = store.finish
    store.finish = async (receipt, result) => { if (failures-- > 0) throw new Error('lost acknowledgement'); return finish(receipt, result) }
    const input = { requestId: crypto.randomUUID(), workspaceId: 1, connectionId: created.connection!.connectionId, expectedRevision: created.connection!.revision }
    expect((await service.remove(input)).status).toBe('uncertain')
    expect((await service.remove(input)).status).toBe('saved')
    expect(deletions).toBe(1)
})

it('preserves an unresolved create reservation across fresh service instances without another effect', async () => {
    const { service, authority, store } = harness()
    const create = authority.create
    let effects = 0
    authority.create = async (input, id) => { effects++; await create(input, id); throw Error('effect outcome unavailable') }
    const input = createInput('Uncertain', 'offline-uncertain-secret')
    const first = await service.create(input)
    const restored = createDesktopApiConnectionService({ authority, store, connectionId: ids, revision: revisions, now, custodyKey: () => Buffer.alloc(32, 9) })
    const again = await restored.create(input)
    expect(again.status).toBe('uncertain')
    expect(again.receipt.connectionId).toBe(first.receipt.connectionId)
    expect(again.receipt.connectionRevision).toBe(first.receipt.connectionRevision)
    expect(effects).toBe(1)
})

it('recovers a committed credential change using the reserved revision after receipt failure', async () => {
    const { service, store, authority } = harness()
    const created = await service.create(createInput('Credential recovery', 'offline-old-secret'))
    const updateKeys = authority.updateKeys
    let updates = 0
    authority.updateKeys = async (id, input) => { updates++; return updateKeys(id, input) }
    const finish = store.finish
    let failure = true
    store.finish = async (receipt, result) => { if (failure) { failure = false; throw Error('lost completion') }; return finish(receipt, result) }
    const input = { requestId: crypto.randomUUID(), workspaceId: 1, connectionId: created.connection!.connectionId, expectedRevision: created.connection!.revision, secret: 'offline-new-secret' }
    const first = await service.credential(input)
    const restored = createDesktopApiConnectionService({ authority, store, connectionId: ids, revision: revisions, now, custodyKey: () => Buffer.alloc(32, 9) })
    const recovered = await restored.credential(input)
    expect(first.status).toBe('uncertain')
    expect(recovered.status).toBe('saved')
    expect(recovered.receipt.connectionRevision).toBe(first.receipt.connectionRevision)
    expect(updates).toBe(1)
})

it('discriminates changed credentials with custody HMAC and rejects same-request replacement', async () => {
    const key = Buffer.alloc(32, 9)
    const input = createInput('HMAC fixture', 'offline-first-credential')
    const first = desktopApiConnectionFingerprint(input, key)
    expect(first).not.toBe(desktopApiConnectionFingerprint({ ...input, secret: 'offline-second-credential' }, key))
    expect(first).not.toBe(desktopApiConnectionFingerprint(input, Buffer.alloc(32, 8)))
    expect(first).not.toContain(input.secret)
    const { service } = harness()
    await service.create(input)
    await expect(service.create({ ...input, secret: 'offline-second-credential' })).rejects.toThrow('identity changed')
})

it('refuses missing custody before reserving a secret-bearing request', async () => {
    const { authority, store } = harness()
    let reserved = 0
    const reserve = store.reserve
    store.reserve = async (receipt, result) => { reserved++; return reserve(receipt, result) }
    const service = createDesktopApiConnectionService({ authority, store, connectionId: ids, revision: revisions, now, custodyKey: () => null })
    expect((await service.create(createInput('No custody', 'offline-secret'))).status).toBe('refused')
    expect(reserved).toBe(0)
    expect(await authority.list()).toHaveLength(0)
})

it('refuses removal if exclusive admission authority is unavailable', async () => {
    const { service, authority } = harness()
    const created = await service.create(createInput('Keep protected', 'offline-secret'))
    const input = { requestId: crypto.randomUUID(), workspaceId: 1, connectionId: created.connection!.connectionId, expectedRevision: created.connection!.revision }
    authority.withRemoval = undefined
    expect((await service.removalPlan(1, input.connectionId)).canRemove).toBe(false)
    expect((await service.remove(input)).status).toBe('refused')
    expect(authority.connection(input.connectionId)).toBeTruthy()
})

it('keeps an incomplete durable reservation uncertain without inventing a replacement identity', async () => {
    const { service, authority, store } = harness()
    const input = createInput('Incomplete reservation', 'offline-secret')
    await store.reserve({ version: 1, requestId: input.requestId, kind: 'create', status: 'uncertain', workspaceId: 1, connectionId: null, connectionRevision: null,
        fingerprint: desktopApiConnectionFingerprint(input, Buffer.alloc(32, 9)), message: 'Offline incomplete fixture', createdAt: now().toISOString(), updatedAt: now().toISOString() }, null)
    const result = await service.create(input)
    expect(result.status).toBe('uncertain')
    expect(result.receipt.connectionId).toBeNull()
    expect(result.receipt.connectionRevision).toBeNull()
    expect(await authority.list()).toHaveLength(0)
})

it('holds exclusive admission through deletion, not only through the initial drain', async () => {
    const { service, authority } = harness()
    authority.removalAvailable = desktopApiConnectionRemovalAvailable
    authority.withRemoval = async (_id, effect) => {
        const release = beginDesktopApiConnectionRemoval()
        if (!release) throw new DesktopApiConnectionRefusal('Workspace is busy')
        try { return await effect() } finally { release() }
    }
    const created = await service.create(createInput('Exclusive deletion', 'offline-secret'))
    let deleting!: () => void
    let finishEffect!: () => void
    const entered = new Promise<void>(resolve => { deleting = resolve })
    const held = new Promise<void>(resolve => { finishEffect = resolve })
    const remove = authority.delete
    authority.delete = async id => { deleting(); await held; return remove(id) }
    const pending = service.remove({ requestId: crypto.randomUUID(), workspaceId: 1, connectionId: created.connection!.connectionId, expectedRevision: created.connection!.revision })
    await entered
    const racingWork = beginDesktopApiConnectionWork()
    try { expect(racingWork).toBeNull() } finally { racingWork?.(); finishEffect() }
    expect((await pending).status).toBe('saved')
    const nextWork = beginDesktopApiConnectionWork()
    try { expect(nextWork).not.toBeNull() } finally { nextWork?.() }
})

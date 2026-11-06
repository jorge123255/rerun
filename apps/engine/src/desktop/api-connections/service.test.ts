import { expect, it } from 'vitest'
import type { ConnectionUsage, CreateConnectionInput, DesktopApiPendingRun, UpdateConnectionInput, UpdateConnectionKeysInput } from '@rerun/contracts'
import type { LoadedConnection } from '../../connections/types.js'
import { createDesktopApiConnectionService, type DesktopApiConnectionAuthority } from './service'
import { memoryDesktopApiConnectionStore } from './store'

let sequence = 0
const ids = () => `cnx_test-${++sequence}`
const revisions = () => `rev_test-${++sequence}`
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
    const catalog = await service.list(1)
    expect(catalog.connections).toHaveLength(2)
    expect(JSON.stringify(catalog)).not.toContain('sk-first')
    expect(JSON.stringify(catalog)).not.toContain('sk-second')
    const selected = await service.select({ requestId: crypto.randomUUID(), workspaceId: 1, connectionId: second.connection!.connectionId, expectedRevision: second.connection!.revision, model: 'gpt-5', source: 'workspace', runId: 'run-1', sessionId: 'session-1' })
    expect(selected.connection!.connectionId).toBe(second.connection!.connectionId)
    const snapshot = await service.executionSnapshot({ connectionId: second.connection!.connectionId, source: 'workspace', runId: 'run-1', sessionId: 'session-1', requestId: 'request-1' })
    expect(snapshot.connectionRevision).toBe(second.connection!.revision)
    expect((await service.credentialForSnapshot(snapshot)).secret).toBe('sk-second')
})

it('refuses to remove the selected default model while preserving the sibling', async () => {
    const { service, authority } = harness()
    const first = await service.create(createInput('First', 'sk-first'))
    const second = await service.create(createInput('Second', 'sk-second'))
    await service.select({ requestId: crypto.randomUUID(), workspaceId: 1, connectionId: second.connection!.connectionId, expectedRevision: second.connection!.revision, model: 'gpt-5', source: 'workspace', runId: 'run-1', sessionId: 'session-1' })
    const result = await service.models({ requestId: crypto.randomUUID(), workspaceId: 1, connectionId: second.connection!.connectionId, expectedRevision: second.connection!.revision, models: [], extraModels: [], expectedDefault: { connectionId: second.connection!.connectionId, model: 'gpt-5' } })
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

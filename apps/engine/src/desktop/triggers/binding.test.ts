import { randomUUID } from 'node:crypto'
import { createClient, type Client } from '@libsql/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { bindDesktopTriggers } from './binding.js'
import { desktopTriggerDefinitionRevision } from './lifecycle.js'
import type { DesktopTriggerAuthority, DesktopTriggerRecord } from './types.js'

const mocks = vi.hoisted(() => ({ getRun: vi.fn() }))
vi.mock('../../db/repos/runs.js', () => ({ getRun: mocks.getRun }))

const clients: Client[] = []
beforeEach(() => {
    vi.clearAllMocks()
    mocks.getRun.mockResolvedValue({ id: 'run', agentId: 'engine', sessionId: 'session', status: 'running' })
})
afterEach(() => { for (const client of clients.splice(0)) client.close() })

async function fixture() {
    const client = createClient({ url: ':memory:' })
    clients.push(client)
    const definitions = new Map<string, DesktopTriggerRecord>()
    const state = { enabled: true, grant: false }
    const assertTriggerGrant = vi.fn(async () => { if (!state.grant) throw new Error('Trigger tool permission is disabled') })
    const replaceTrigger = vi.fn<NonNullable<DesktopTriggerAuthority['replaceTrigger']>>(async (_id, slug, before, next) => {
        if (desktopTriggerDefinitionRevision(definitions.get(slug) ?? null) !== desktopTriggerDefinitionRevision(before)) throw new Error('Definition changed')
        if (next) definitions.set(slug, next)
        else definitions.delete(slug)
        return next
    })
    const authority: DesktopTriggerAuthority = {
        assertActive: () => {},
        resolveOwnerByEngineId: async () => ({ localAgentId: 'local', engineAgentId: 'engine', enabled: state.enabled, deleting: false }),
        assertTriggerGrant,
        assertSetupClear: async () => {},
        resolveAutomationModel: async () => ({ connectionId: 'connection', provider: null, model: 'model' }),
        startTriggerRun: async () => { throw new Error('No run should start during management') },
        cancelExactRun: async () => {},
        readRun: async () => null,
        readSession: async () => null,
        adoptTriggerSession: async () => { throw new Error('No chat should be created during management') },
        routeHuman: async () => {},
        ingressOrigin: () => ({ enabled: false, origin: null, bindHost: '127.0.0.1', bindPort: null, hostingDecision: 'unresolved' }),
        listTriggers: async () => [...definitions.values()],
        readTrigger: async (_id, slug) => definitions.get(slug) ?? null,
        replaceTrigger,
        writeTrigger: async () => { throw new Error('Use definition CAS') },
        rotateTriggerToken: async () => { throw new Error('Use definition CAS') },
        deleteTrigger: async () => { throw new Error('Use definition CAS') },
        markFired: async () => {},
    }
    const binding = bindDesktopTriggers({ getSystemClient: async () => client, authority })
    await binding.store.initialize('engine')
    const create = () => binding.lifecycle.create('engine', {
        requestId: randomUUID(), name: 'Human hook', description: '', body: 'Read the delivery',
        methods: ['POST'], connectionId: null, provider: null, model: null,
    })
    return { binding, state, definitions, replaceTrigger, assertTriggerGrant, create }
}

describe('human trigger management and model tool permission', () => {
    it('allows human create, read, update, rotate and delete while model trigger tools are disabled', async () => {
        const f = await fixture()
        const created = await f.create()
        expect((await f.binding.lifecycle.list('engine')).map(trigger => trigger.slug)).toEqual(['human-hook'])
        expect(await f.binding.lifecycle.get('engine', created.slug, { includeToken: true })).toMatchObject({ token: created.token, body: 'Read the delivery' })
        const updated = await f.binding.lifecycle.update('engine', created.slug, { requestId: randomUUID(), expectedRevision: created.revision, body: 'Updated instruction' })
        expect(f.definitions.get(created.slug)?.body).toBe('Updated instruction')
        const rotated = await f.binding.lifecycle.rotate('engine', created.slug, { requestId: randomUUID(), expectedRevision: updated.revision })
        expect(rotated.token).not.toBe(created.token)
        await f.binding.lifecycle.remove('engine', created.slug, { requestId: randomUUID(), expectedRevision: rotated.revision })
        expect(await f.binding.lifecycle.list('engine')).toEqual([])
        expect(f.replaceTrigger).toHaveBeenCalledTimes(4)
        expect(f.assertTriggerGrant).not.toHaveBeenCalled()
        expect(f.state.grant).toBe(false)
    })

    it.each([
        ['trigger_list', {}],
        ['trigger_get', { slug: 'human-hook' }],
        ['trigger_create', { name: 'Model hook', description: '', body: 'Do work' }],
        ['trigger_update', { slug: 'human-hook', body: 'Changed by model' }],
        ['trigger_rotate_token', { slug: 'human-hook' }],
        ['trigger_delete', { slug: 'human-hook' }],
    ] as const)('still denies %s from an active owned model run while its grant is off', async (name, args) => {
        const f = await fixture()
        const created = await f.create()
        f.replaceTrigger.mockClear()
        const tools = f.binding.toolFactory('engine', { runId: 'run', sessionId: 'session', abortSignal: new AbortController().signal })
        await expect(tools[name]!.execute(args, { toolCallId: 'tool-call' })).rejects.toThrow('Trigger tool permission is disabled')
        expect(f.assertTriggerGrant).toHaveBeenCalledWith('engine')
        expect(f.replaceTrigger).not.toHaveBeenCalled()
        expect(f.definitions.get(created.slug)?.token).toBe(created.token)
        expect(f.definitions.get(created.slug)?.body).toBe('Read the delivery')
    })

    it('checks the model grant again immediately before a reserved mutation writes', async () => {
        const f = await fixture()
        f.assertTriggerGrant.mockResolvedValueOnce(undefined).mockResolvedValueOnce(undefined)
        const tools = f.binding.toolFactory('engine', { runId: 'run', sessionId: 'session', abortSignal: new AbortController().signal })
        await expect(tools.trigger_create!.execute({ name: 'Model hook', description: '', body: 'Do work' }, { toolCallId: 'tool-call' })).rejects.toThrow('Trigger tool permission is disabled')
        expect(f.assertTriggerGrant).toHaveBeenCalledTimes(3)
        expect(await f.binding.store.findPendingIntent('engine', 'model-hook')).not.toBeNull()
        expect(f.replaceTrigger).not.toHaveBeenCalled()
        expect(f.definitions.size).toBe(0)
    })

    it('keeps disabled coworker management separate from the model tool grant', async () => {
        const f = await fixture()
        f.state.enabled = false
        await expect(f.create()).rejects.toMatchObject({ status: 403, message: 'Enable this coworker to manage triggers' })
        expect(f.replaceTrigger).not.toHaveBeenCalled()
        expect(f.assertTriggerGrant).not.toHaveBeenCalled()
    })
})

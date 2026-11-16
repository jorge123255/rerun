import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { WorkspaceContext } from '@/app/api/_auth/ownership'

vi.mock('server-only', () => ({}))
const mocks = vi.hoisted(() => ({ getAgent: vi.fn(), listConnections: vi.fn(), patchAgent: vi.fn(), assertModelEntitled: vi.fn() }))
vi.mock('@/app/api/_services/chat.service', () => ({ resolveAgentTarget: async () => ({ conn: { host: 'box' }, engineAgentId: 'eng-1' }) }))
vi.mock('@/app/api/_services/engine-plan.service', () => ({ assertModelEntitled: mocks.assertModelEntitled }))
vi.mock('@/lib/engine/client', () => ({ getAgent: mocks.getAgent, listConnections: mocks.listConnections, patchAgent: mocks.patchAgent }))

const { readAgentModels, setAgentModel } = await import('./agent-model.service')

const ctx = { workspace: { id: 7, subscription_status: 'active', is_sandbox: false } } as unknown as WorkspaceContext
const connection = (patch: object) => ({ id: 'claude', name: 'Claude', provider: 'claude-code', models: ['claude-opus-5-5'], extraModels: [], createdAt: '', connected: true, credentialRejected: false, planLimits: null, ...patch })

describe('agent models', () => {
    beforeEach(() => {
        Object.values(mocks).forEach(mock => mock.mockReset())
        mocks.listConnections.mockResolvedValue({ connections: [connection({}), connection({ id: 'rerun', name: 'Rerun', provider: 'openrouter', models: ['rerun-fast', 'rerun-max'] }), connection({ id: 'gone', connected: false })], default: null })
        mocks.getAgent.mockResolvedValue({ config: { connectionId: 'claude', model: 'claude-opus-5-5' }, resolvedConnectionId: 'claude', resolvedModel: 'claude-opus-5-5' })
    })

    it('lists the connected connections as the web picker does, Rerun first, with the pin and what runs', async () => {
        const models = await readAgentModels(ctx, 'a1')
        expect(models.groups.map(group => group.connectionId)).toEqual(['rerun', 'claude'])
        expect(models.pinned).toEqual({ connectionId: 'claude', model: 'claude-opus-5-5' })
        expect(models.resolved).toEqual({ connectionId: 'claude', model: 'claude-opus-5-5' })
        expect(models.boxDefault).toEqual({ connectionId: 'rerun', model: models.groups[0].defaultModel })
    })

    it('reads a coworker that follows the box as pinned to nothing', async () => {
        mocks.getAgent.mockResolvedValue({ config: { connectionId: 'claude', model: null }, resolvedConnectionId: 'rerun', resolvedModel: 'rerun-max' })
        expect((await readAgentModels(ctx, 'a1')).pinned).toBeNull()
    })

    it('pins a model with the provider of its connection, after the plan check', async () => {
        await setAgentModel(ctx, 'a1', { connectionId: 'rerun', model: 'rerun-fast' })
        expect(mocks.assertModelEntitled).toHaveBeenCalledWith('rerun-fast', 7)
        expect(mocks.patchAgent).toHaveBeenCalledWith({ host: 'box' }, 'eng-1', { connectionId: 'rerun', provider: 'openrouter', model: 'rerun-fast' })
    })

    it('refuses a connection the machine does not hold, or holds without its credential', async () => {
        await expect(setAgentModel(ctx, 'a1', { connectionId: 'gone', model: 'x' })).rejects.toMatchObject({ status: 400 })
        expect(mocks.patchAgent).not.toHaveBeenCalled()
    })

    it('follows the box again by clearing all three fields', async () => {
        await setAgentModel(ctx, 'a1', { connectionId: null, model: null })
        expect(mocks.patchAgent).toHaveBeenCalledWith({ host: 'box' }, 'eng-1', { connectionId: null, provider: null, model: null })
        expect(mocks.assertModelEntitled).not.toHaveBeenCalled()
    })
})

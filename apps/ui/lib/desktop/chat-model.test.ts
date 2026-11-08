import type { BoxDefaultModel, ConnectionSummary } from '@rerun/contracts'
import { describe, expect, it } from 'vitest'
import { buildDesktopModelView, desktopReasoningChoice, usableConnection, type DesktopModelPick } from './chat-model'

function connection(partial: Partial<ConnectionSummary> & Pick<ConnectionSummary, 'id' | 'provider' | 'models'>): ConnectionSummary {
    return { name: partial.provider, extraModels: [], createdAt: '2026-01-01T00:00:00.000Z', connected: true, credentialRejected: false, planLimits: null, ...partial }
}

const local = connection({ id: 'local', name: 'Local', provider: 'openrouter', models: ['model-workspace', 'model-coworker', 'model-chat'] })
const codex = connection({
    id: 'codex', name: 'ChatGPT', provider: 'codex', models: ['terra', 'luna'],
    codexReasoning: {
        terra: { supported: ['low', 'medium', 'high'], default: 'medium' },
        luna: { supported: ['low', 'medium'], default: 'low' },
    },
})
const workspace: BoxDefaultModel = { connectionId: 'codex', model: 'terra', reasoningEffort: 'high' }

describe('desktop model selection', () => {
    it('mirrors the Codex effort choice without writing a new one', () => {
        expect(desktopReasoningChoice(codex, 'terra', workspace)).toEqual({ effort: 'high', source: 'workspace' })
        expect(desktopReasoningChoice(codex, 'luna', workspace)).toEqual({ effort: 'low', source: 'model-default' })
        expect(desktopReasoningChoice(codex, 'terra', { ...workspace, reasoningEffort: 'ultra' })).toEqual({ effort: 'medium', source: 'model-default' })
        expect(desktopReasoningChoice(codex, 'terra', { connectionId: 'local', model: 'terra', reasoningEffort: 'high' })).toEqual({ effort: 'medium', source: 'model-default' })
        expect(desktopReasoningChoice(local, 'model-workspace', { connectionId: 'local', model: 'model-workspace' })).toBeUndefined()
        expect(desktopReasoningChoice(codex, 'terra', null)).toEqual({ effort: 'medium', source: 'model-default' })
    })

    it('offers exact registered custom models and keeps disconnected choices unavailable', () => {
        const custom = connection({ id: 'custom-fixture', name: 'Fixture endpoint', provider: 'custom', customRevision: 1, models: ['synthetic/model'] })
        const missingRevision = connection({ id: 'unregistered', provider: 'custom', models: ['unregistered/model'] })
        const conversation = { connectionId: custom.id, model: 'synthetic/model' }
        const base = { workspace, coworker: null, conversation }
        const available = buildDesktopModelView({ ...base, connections: [codex, custom, missingRevision] })
        expect(available.catalog.map(group => group.connectionId)).toEqual([codex.id, custom.id])
        expect(available.effective).toMatchObject({ ...conversation, provider: 'custom', source: 'conversation', available: true })
        const disconnected = buildDesktopModelView({ ...base, connections: [codex, { ...custom, connected: false }] })
        expect(disconnected.effective).toMatchObject({ ...conversation, source: 'conversation', available: false })
    })

    it('resolves a conversation, then a coworker pin, then the workspace, and leaves an unavailable choice in place', () => {
        const input = {
            connections: [local, codex, connection({ id: 'off', provider: 'openai', models: ['hidden'], connected: false }), connection({ id: 'empty', provider: 'google', models: [] })],
            workspace: { connectionId: 'local', model: 'model-workspace' } satisfies BoxDefaultModel,
            coworker: { connectionId: 'local', provider: 'openrouter', model: 'model-coworker' },
            conversation: { connectionId: 'local', model: 'model-chat' } satisfies DesktopModelPick,
        }
        const snapshot = structuredClone(input)
        const pinned = buildDesktopModelView({ ...input, conversation: null })
        const override = buildDesktopModelView(input)
        const workspaceOnly = buildDesktopModelView({ ...input, coworker: { connectionId: 'local', provider: 'openrouter', model: null }, conversation: null })
        const unavailable = buildDesktopModelView({ ...input, conversation: { connectionId: 'local', model: 'model-retired' }, coworker: input.coworker })
        expect(input).toEqual(snapshot)
        expect(override.effective).toMatchObject({ source: 'conversation', model: 'model-chat', available: true, name: 'Local' })
        expect(override.coworker).toMatchObject({ model: 'model-coworker', available: true })
        expect(override.workspace).toMatchObject({ model: 'model-workspace' })
        expect(pinned.effective).toMatchObject({ source: 'coworker', model: 'model-coworker' })
        expect(workspaceOnly.effective).toMatchObject({ source: 'workspace', model: 'model-workspace', available: true })
        expect(workspaceOnly.coworker).toBeNull()
        expect(unavailable.conversation).toMatchObject({ model: 'model-retired', available: false })
        expect(unavailable.effective).toMatchObject({ source: 'conversation', model: 'model-retired', available: false, label: 'model-retired' })
        expect(unavailable.coworker?.model).toBe('model-coworker')
        expect(unavailable.workspace?.model).toBe('model-workspace')
        expect(unavailable.catalog.map(group => group.connectionId)).toEqual(['local', 'codex'])
        expect(usableConnection([local], { connectionId: 'local', model: 'model-retired' })).toBeNull()
    })
})

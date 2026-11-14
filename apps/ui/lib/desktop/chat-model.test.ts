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
    it('uses the discovered subscription label and reasoning, and does not substitute another account', () => {
        const kimi = connection({
            id: 'mac-kimi-code-00000000-0000-4000-8000-000000000001',
            provider: 'kimi-code', name: 'Kimi Code', models: ['fixture-model'],
            subscriptionModels: [{
                id: 'fixture-model', label: 'Kimi fixture model', reasoning: { supported: ['low', 'high'], default: 'low' },
            }],
        })
        const conversation = { connectionId: kimi.id, model: 'fixture-model' }
        const selected = { ...conversation, reasoningEffort: 'high' }
        const view = buildDesktopModelView({ connections: [kimi, codex], workspace: selected, coworker: null, conversation })
        expect(view.catalog[0]?.models).toEqual([{ id: 'fixture-model', label: 'Kimi fixture model' }])
        expect(view.effective).toMatchObject({
            ...conversation, provider: 'kimi-code', label: 'Kimi fixture model', available: true,
            reasoning: { effort: 'high', source: 'workspace' },
        })
        const next = { ...kimi, id: kimi.id.replace(/1$/, '2') }
        const revoked = buildDesktopModelView({ connections: [next, codex], workspace, coworker: null, conversation })
        expect(revoked.effective).toMatchObject({ ...conversation, source: 'conversation', available: false })
    })

    it('mirrors the Codex effort choice without writing a new one', () => {
        expect(desktopReasoningChoice(codex, 'terra', workspace)).toEqual({ effort: 'high', source: 'workspace' })
        expect(desktopReasoningChoice(codex, 'luna', workspace)).toEqual({ effort: 'low', source: 'model-default' })
        expect(desktopReasoningChoice(codex, 'terra', { ...workspace, reasoningEffort: 'ultra' })).toEqual({ effort: 'medium', source: 'model-default' })
        expect(desktopReasoningChoice(codex, 'terra', { connectionId: 'local', model: 'terra', reasoningEffort: 'high' })).toEqual({ effort: 'medium', source: 'model-default' })
        expect(desktopReasoningChoice(local, 'model-workspace', { connectionId: 'local', model: 'model-workspace' })).toBeUndefined()
        expect(desktopReasoningChoice(codex, 'terra', null)).toEqual({ effort: 'medium', source: 'model-default' })
    })

    it('uses the effort chosen for a model wherever it runs, ahead of the workspace default and the model default', () => {
        const efforts = { 'codex::terra': 'low', 'codex::luna': 'ultra' }
        expect(desktopReasoningChoice(codex, 'terra', workspace, efforts)).toEqual({ effort: 'low', source: 'model' })
        // An effort the model no longer offers is ignored.
        expect(desktopReasoningChoice(codex, 'luna', workspace, efforts)).toEqual({ effort: 'low', source: 'model-default' })
        const view = buildDesktopModelView({ connections: [codex, local], workspace, coworker: null, conversation: { connectionId: 'codex', model: 'terra' }, efforts })
        expect(view.effective).toMatchObject({ reasoning: { effort: 'low', source: 'model' }, reasoningOptions: ['low', 'medium', 'high'] })
        // A model with no effort levels offers nothing to choose.
        expect(buildDesktopModelView({ connections: [codex, local], workspace, coworker: null, conversation: { connectionId: 'local', model: 'model-chat' } }).effective.reasoningOptions).toBeUndefined()
    })

    it('offers the Claude subscription its own effort levels, with no default of its own', () => {
        const claude = connection({ id: 'mac-claude', name: 'Claude', provider: 'claude', models: ['claude-opus-5-5'] })
        const pick = { connectionId: 'mac-claude', model: 'claude-opus-5-5' }
        const plain = buildDesktopModelView({ connections: [claude], workspace: pick, coworker: null, conversation: null })
        expect(plain.effective.reasoningOptions).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
        expect(plain.effective.reasoning).toBeUndefined()
        const chosen = buildDesktopModelView({ connections: [claude], workspace: pick, coworker: null, conversation: null, efforts: { 'mac-claude::claude-opus-5-5': 'xhigh' } })
        expect(chosen.effective.reasoning).toEqual({ effort: 'xhigh', source: 'model' })
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

    it('displays the selected Grok API effort only for its exact connection revision and model', () => {
        const model = 'grok-fixture'
        const grok = connection({ id: 'grok-api', provider: 'custom', models: [model], customRevision: 2,
            customReasoning: { [model]: { supported: ['low', 'xhigh'], default: 'low' } } })
        const selected = { connectionId: grok.id, model, reasoningEffort: 'xhigh', customReasoningRevision: 2 }
        const view = (current: ConnectionSummary) => buildDesktopModelView({
            connections: [current], workspace: selected, coworker: null, conversation: null,
        }).effective
        expect(view(grok).reasoning).toEqual({ effort: 'xhigh', source: 'workspace' })
        expect(view({ ...grok, customRevision: 3 })).toMatchObject({ reasoningUnavailable: true })
        expect(view({ ...grok, customRevision: 3 }).reasoning).toBeUndefined()
        expect(view({ ...grok, customReasoning: undefined })).toMatchObject({ reasoningUnavailable: true })
    })

    it('keeps an unbound coworker pin visible as unavailable instead of projecting the workspace default', () => {
        const view = buildDesktopModelView({
            connections: [codex], workspace, coworker: { connectionId: null, provider: 'anthropic', model: 'saved-legacy-model' }, conversation: null,
        })
        expect(view.effective).toMatchObject({
            source: 'coworker', connectionId: null, model: 'saved-legacy-model', available: false,
        })
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

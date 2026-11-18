import { describe, expect, it } from 'vitest'
import { DESKTOP_PRESET_CONNECTION_ID, desktopPlanExhausted, desktopPresetFallbackNote, desktopPresetUnavailable, resolveDesktopPreset, type ConnectionSummary } from '@rerun/contracts'
import { buildDesktopModelView } from './chat-model'

const now = new Date('2026-11-15T12:00:00.000Z')
const later = '2026-11-15T17:00:00.000Z', earlier = '2026-11-15T09:00:00.000Z'
function connection(id: string, provider: string, models: string[], extra: Partial<ConnectionSummary> = {}): ConnectionSummary {
    return { id, name: id, provider, models, extraModels: [], createdAt: now.toISOString(), connected: true, credentialRejected: false, planLimits: null, ...extra } as ConnectionSummary
}
const chatgpt = connection('mac-chatgpt', 'codex', ['gpt-6-sol', 'gpt-6.1-terra', 'gpt-6-luna'])
const claude = connection('mac-claude', 'claude', ['claude-opus-5-5', 'claude-haiku-5-5'])
const openrouter = connection('openrouter', 'openrouter', ['openai/gpt-6-luna', 'openai/gpt-6-sol'])
const full = (resetsAt: string | null) => ({ windows: [{ kind: 'session' as const, label: null, usedPercent: 100, resetsAt }], capturedAt: now.toISOString() })

describe('Rerun presets in the Mac app', () => {
    it('answers each name with the model Rerun Cloud uses, through the owner’s own plan', () => {
        const all = [chatgpt, claude, openrouter]
        expect(resolveDesktopPreset('fast', all, now)).toMatchObject({ connectionId: 'mac-chatgpt', model: 'gpt-6-luna', preferred: true })
        expect(resolveDesktopPreset('balanced', all, now)).toMatchObject({ connectionId: 'mac-claude', model: 'claude-haiku-5-5', preferred: true })
        expect(resolveDesktopPreset('smart', all, now)).toMatchObject({ connectionId: 'mac-chatgpt', model: 'gpt-6-sol', preferred: true })
    })

    it('moves to the next plan when the first is out of usage, and back once the limit has reset', () => {
        const spent = { ...chatgpt, planLimits: full(later) }
        expect(resolveDesktopPreset('fast', [spent, claude], now)).toMatchObject({ connectionId: 'mac-claude', model: 'claude-haiku-5-5', preferred: false, skipped: [{ name: 'mac-chatgpt', reason: 'out-of-usage' }] })
        expect(resolveDesktopPreset('fast', [{ ...chatgpt, planLimits: full(earlier) }, claude], now)).toMatchObject({ connectionId: 'mac-chatgpt', preferred: true })
        expect(desktopPlanExhausted({ windows: [{ kind: 'model', label: 'Opus', usedPercent: 100, resetsAt: later }], capturedAt: now.toISOString() }, now)).toBe(false)
    })

    it('skips a plan that is signed out, was turned away, or does not offer the model', () => {
        expect(resolveDesktopPreset('smart', [{ ...chatgpt, connected: false }, claude], now)).toMatchObject({ connectionId: 'mac-claude', model: 'claude-opus-5-5' })
        expect(resolveDesktopPreset('balanced', [chatgpt, { ...claude, credentialRejected: true }], now)).toMatchObject({ connectionId: 'mac-chatgpt', model: 'gpt-6.1-terra' })
        expect(resolveDesktopPreset('smart', [connection('mac-chatgpt', 'codex', ['gpt-6-luna']), claude], now)).toMatchObject({ connectionId: 'mac-claude' })
    })

    it('never moves from a plan that ran out to a key billed per token', () => {
        const spent = [{ ...chatgpt, planLimits: full(later) }, { ...claude, planLimits: full(null) }, openrouter]
        expect(resolveDesktopPreset('fast', spent, now)).toBeNull()
        expect(desktopPresetUnavailable('fast', spent, now)).toContain('no plan with usage left')
        // With no plan connected at all, a key is the only way to run and is used.
        expect(resolveDesktopPreset('fast', [openrouter], now)).toMatchObject({ connectionId: 'openrouter', model: 'openai/gpt-6-luna' })
        expect(resolveDesktopPreset('fast', [], now)).toBeNull()
    })

    it('offers the presets only where asked, shows what each runs on, and reads a preset pick', () => {
        const base = { connections: [chatgpt, claude], workspace: { connectionId: 'mac-chatgpt', model: 'gpt-6-sol' }, coworker: null, conversation: null, now }
        expect(buildDesktopModelView(base).catalog.map(group => group.connectionId)).toEqual(['mac-chatgpt', 'mac-claude'])
        const view = buildDesktopModelView({ ...base, presets: true, conversation: { connectionId: DESKTOP_PRESET_CONNECTION_ID, model: 'balanced' } })
        expect(view.catalog[0]).toMatchObject({ connectionId: DESKTOP_PRESET_CONNECTION_ID, name: 'Rerun', provider: 'rerun' })
        expect(view.catalog[0]!.models.map(model => model.id)).toEqual(['fast', 'balanced', 'smart'])
        expect(view.effective).toMatchObject({ source: 'conversation', connectionId: DESKTOP_PRESET_CONNECTION_ID, model: 'balanced', available: true })
        expect(view.effective.label).toContain('Rerun Balanced · ')
        expect(view.effective.reasoningOptions).toBeUndefined()
        const pinned = buildDesktopModelView({ ...base, presets: true, coworkerPreset: 'smart' })
        expect(pinned.coworker).toMatchObject({ connectionId: DESKTOP_PRESET_CONNECTION_ID, model: 'smart', available: true })
        expect(pinned.effective).toMatchObject({ source: 'coworker', model: 'smart' })
        // A preset left on a chat reads as unavailable where presets are not offered, never as a real model.
        expect(buildDesktopModelView({ ...base, conversation: { connectionId: DESKTOP_PRESET_CONNECTION_ID, model: 'fast' } }).effective.available).toBe(false)
    })
})

describe('a preset as the workspace default', () => {
    it('shows the plan it runs on now in the picker’s workspace row, and the saved model when no plan can', () => {
        const saved = { connectionId: 'mac-chatgpt', model: 'gpt-6-sol' }
        const now = buildDesktopModelView({ connections: [chatgpt, claude], workspace: { connectionId: 'mac-claude', model: 'claude-haiku-5-5' }, coworker: null, conversation: null, presets: true })
        expect(now.workspace).toMatchObject({ connectionId: 'mac-claude', model: 'claude-haiku-5-5' })
        expect(now.effective).toMatchObject({ source: 'workspace', connectionId: 'mac-claude', model: 'claude-haiku-5-5', available: true })
        expect(buildDesktopModelView({ connections: [chatgpt, claude], workspace: saved, coworker: null, conversation: null }).effective.model).toBe('gpt-6-sol')
    })
})

describe('saying so when a preset is not on its first choice', () => {
    it('names what is answering and why the first choice is not', () => {
        const spent = resolveDesktopPreset('balanced', [chatgpt, { ...claude, planLimits: full(later) }], now)
        expect(desktopPresetFallbackNote(spent, 'GPT-6.1 Terra')).toBe('Rerun Balanced is answering on mac-chatgpt · GPT-6.1 Terra: mac-claude is out of usage.')
        const signedOut = resolveDesktopPreset('smart', [{ ...chatgpt, connected: false }, claude], now)
        expect(desktopPresetFallbackNote(signedOut, 'Opus 5.5')).toContain('mac-chatgpt is not connected')
    })

    it('says nothing when the preset is on its first choice, or cannot run at all', () => {
        expect(desktopPresetFallbackNote(resolveDesktopPreset('fast', [chatgpt, claude], now), 'GPT-6 Luna')).toBeNull()
        expect(desktopPresetFallbackNote(null, '')).toBeNull()
    })
})

it('identifies the real provider behind a saved coworker preset only while a plan resolves', () => {
    const base = { workspace: null, coworker: null, conversation: null, presets: true, coworkerPreset: 'smart' as const, now }
    const provider = (connections: ConnectionSummary[]) => buildDesktopModelView({ ...base, connections }).effective.presetProvider
    expect(provider([claude, chatgpt])).toBe('codex')
    expect(provider([claude, { ...chatgpt, connected: false }])).toBe('claude')
    expect(provider([])).toBeUndefined()
})

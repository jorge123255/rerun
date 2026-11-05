// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
import { brainMutationIntent, reserveBrainMutation, settleBrainMutation } from './mutation-intents'
const store = vi.hoisted(() => new Map<string, unknown>())
vi.mock('@/lib/desktop/brain-ui-state', () => ({ readBrainUiState: (key: string) => store.get(key) ?? null,
    writeBrainUiState: async (key: string, value: unknown) => { store.set(key, value) } }))
afterEach(() => store.clear())
it('persists the exact mutation before send and retains it across an uncertain retry', async () => {
    const initial = await reserveBrainMutation('save:company', { kind: 'save', slug: 'company', input: {
        title: 'Company', type: 'company', content: 'First edit', sources: [], baseHash: 'a'.repeat(32),
    } })
    await settleBrainMutation('save:company', { ok: false, uncertain: true })
    expect(brainMutationIntent('save:company')).toEqual(initial)
    expect(await reserveBrainMutation('save:company', { kind: 'save', slug: 'company', input: {
        title: 'Company', type: 'company', content: 'Later edit', sources: [], baseHash: 'b'.repeat(32),
    } })).toEqual(initial)
    await settleBrainMutation('save:company', { ok: true })
    expect(brainMutationIntent('save:company')).toBeNull()
})
it('does not replace an unreadable pending request with a fresh mutation', async () => {
    store.set('intent:delete:company', { requestId: 'broken' })
    await expect(reserveBrainMutation('delete:company', { kind: 'delete', slug: 'company', expectedHash: 'a'.repeat(32) })).rejects.toThrow()
    expect(store.get('intent:delete:company')).toEqual({ requestId: 'broken' })
})

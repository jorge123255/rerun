import { describe, expect, it } from 'vitest'
import { DEFAULT_CONNECTION_MODELS, MODEL_CONTEXT_WINDOW, MODEL_LABEL, isPremiumModel, providerSchema, trialModelFor } from '@rerun/contracts'
import { ENGINE_MODEL_CATALOG, catalogFor } from './models'

describe('ENGINE_MODEL_CATALOG', () => {
    // The engine seeds a new connection from DEFAULT_CONNECTION_MODELS and has no way to read this
    // catalog; the catalog carries the labels and power ratings the engine has no use for. Two
    // files, one list of ids — if they drift, a connection offers a model the picker cannot name,
    // or hides one it should show.
    it('offers exactly the ids a new connection is seeded with', () => {
        for (const provider of providerSchema.options) {
            const group = ENGINE_MODEL_CATALOG.find(g => g.provider === provider)
            expect(group?.models.map(m => m.id) ?? [], `catalog for ${provider}`).toEqual(DEFAULT_CONNECTION_MODELS[provider])
        }
    })

    // A label missing from the contract is not a crash, it is a picker row reading `gpt-5.6-sol`
    // where every other row reads like a product name. The iOS chip has no catalog to fall back on.
    it('names every id it offers', () => {
        for (const { models } of ENGINE_MODEL_CATALOG) {
            for (const { id } of models) expect(MODEL_LABEL[id], `label for ${id}`).toBeDefined()
        }
    })

    it('answers for a provider it has never heard of', () => {
        const unknown = catalogFor('some-future-provider')
        expect(unknown.models).toEqual([])
        expect(unknown.label).toBe('some-future-provider')
    })
})

describe('premium models on a trial', () => {
    const premium = providerSchema.options.flatMap(provider => DEFAULT_CONNECTION_MODELS[provider].filter(isPremiumModel).map(model => ({ provider, model })))

    it('covers Opus, Fable and Astra, and leaves Sonnet and Sol open', () => {
        expect(premium.map(p => p.model)).toEqual(expect.arrayContaining(['claude-opus-5-5', 'claude-fable-5-1', 'claude-fable-5-2', 'claude-opus-4-8[1m]', 'gpt-6-astra', 'openai/gpt-6-astra', 'anthropic/claude-opus-5.5', 'anthropic/claude-fable-5.2']))
        expect(MODEL_LABEL['claude-fable-5-2']).toBe('Fable 5.2')
        expect(MODEL_LABEL['anthropic/claude-fable-5.2']).toBe('Fable 5.2')
        expect(MODEL_CONTEXT_WINDOW['claude-fable-5-2']).toBe(1_000_000)
        expect(MODEL_CONTEXT_WINDOW['anthropic/claude-fable-5.2']).toBe(1_000_000)
        for (const model of ['claude-sonnet-5[1m]', 'claude-haiku-4-5', 'gpt-6-sol', 'gpt-5.6-sol', 'gpt-6-luna', 'rerun-smart']) expect(isPremiumModel(model), model).toBe(false)
    })

    // The box runs the substitute without asking the connection, so it has to be a model the
    // provider knows and the compaction has a window for.
    it('steps every premium model down to one the same connection offers', () => {
        for (const { provider, model } of premium) {
            const substitute = trialModelFor(provider, model)
            expect(isPremiumModel(substitute), `${provider}:${model}`).toBe(false)
            expect(DEFAULT_CONNECTION_MODELS[provider], `${provider}:${model}`).toContain(substitute)
            expect(MODEL_CONTEXT_WINDOW[substitute], substitute).toBeDefined()
        }
    })
})

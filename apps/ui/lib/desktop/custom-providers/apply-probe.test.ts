import { describe, expect, it } from 'vitest'
import type { CustomProviderModel, CustomProviderProbe } from '@rerun/contracts'
import { applyProbe, selectionFromDraftProbe, type ProbeTicket } from './apply-probe'

const manual: CustomProviderModel = { id: 'llama3.3:70b', contextWindow: null, vision: false, source: 'manual' }
const ticket: ProbeTicket = { generation: 1, workspaceId: 1, connectionId: 'cnx-ollama', revision: 1, baseUrl: 'http://localhost:11434/v1' }

function probe(patch: Partial<CustomProviderProbe> = {}): CustomProviderProbe {
    return {
        identity: { workspaceId: 1, connectionId: 'cnx-ollama', revision: 1 },
        status: 'unavailable', models: [], problem: 'not_listed', manualModel: manual.id, manualUsable: true, observedAt: 1,
        ...patch,
    }
}

describe('applyProbe', () => {
    it('drops a probe for an older endpoint or another workspace', () => {
        expect(applyProbe({ ticket, current: { ...ticket, generation: 2 }, probe: probe({ status: 'fresh', problem: null, models: [{ id: 'stale-model', contextWindow: 8192, vision: false, source: 'discovered' }] }), selected: [manual], manualSeedId: manual.id, defaultModelId: null })).toEqual({ apply: false })
        expect(applyProbe({ ticket, current: { ...ticket, workspaceId: 2 }, probe: probe(), selected: [manual], manualSeedId: null, defaultModelId: null })).toEqual({ apply: false })
        expect(applyProbe({ ticket, current: ticket, probe: probe({ problem: 'stale_revision' }), selected: [manual], manualSeedId: null, defaultModelId: null })).toEqual({ apply: false })
    })

    it('keeps a typed model when the server does not list one and does not invent a catalog', () => {
        const applied = applyProbe({ ticket, current: ticket, probe: probe(), selected: [manual], manualSeedId: manual.id, defaultModelId: null })
        expect(applied).toMatchObject({ apply: true, selected: [manual], catalogModels: null, asksModel: true })
        if (applied.apply) expect(applied.notice).toContain('Type the id')
        expect(JSON.stringify(applied)).not.toContain('discovered')
    })

    it('seeds the first listed models and still keeps the typed model and the default', () => {
        const discovered = Array.from({ length: 12 }, (_, index) => ({ id: `model-${index}`, contextWindow: 8192, vision: false, source: 'discovered' as const }))
        const applied = applyProbe({ ticket, current: ticket, probe: probe({ status: 'fresh', problem: null, models: discovered, manualModel: null, manualUsable: false }), selected: [manual], manualSeedId: manual.id, defaultModelId: manual.id })
        expect(applied.apply).toBe(true)
        if (!applied.apply) return
        expect(applied.selected.slice(0, 10).map(model => model.id)).toEqual(discovered.slice(0, 10).map(model => model.id))
        expect(applied.selected.map(model => model.id)).toContain(manual.id)
        expect(applied.catalogModels).toHaveLength(12)
    })

    it('does not clear the saved models when the endpoint refuses the key', () => {
        const applied = applyProbe({ ticket, current: ticket, probe: probe({ problem: 'unauthorized', manualUsable: false }), selected: [manual], manualSeedId: null, defaultModelId: null })
        expect(applied).toMatchObject({ apply: true, selected: [manual], catalogModels: null, asksModel: false })
        if (applied.apply) expect(applied.notice).toContain('turned this key down')
    })
})

describe('selectionFromDraftProbe', () => {
    it('asks for a model id when nothing is listed and does not copy a fake catalog', () => {
        const picked = selectionFromDraftProbe({ status: 'unavailable', models: [{ id: 'invented-model', contextWindow: null, vision: false, source: 'discovered' }], problem: 'not_listed', manualModel: null, manualUsable: false })
        expect(picked).toEqual({ models: null, asksModel: true })
        expect(JSON.stringify(picked)).not.toContain('invented-model')
    })

    it('saves only the typed model when the list is missing and that model answers', () => {
        const picked = selectionFromDraftProbe({ status: 'unavailable', models: [{ id: 'invented-model', contextWindow: null, vision: false, source: 'discovered' }], problem: 'not_listed', manualModel: manual.id, manualUsable: true })
        expect(picked.models).toEqual([manual])
        expect(JSON.stringify(picked)).not.toContain('discovered')
    })

    it('keeps a listed model ahead of the rest and stops at ten', () => {
        const discovered = Array.from({ length: 12 }, (_, index) => ({ id: `model-${index}`, contextWindow: 8192, vision: false, source: 'discovered' as const }))
        const picked = selectionFromDraftProbe({ status: 'fresh', models: discovered, problem: null, manualModel: 'model-11', manualUsable: true })
        expect(picked.models?.map(model => model.id)).toEqual(['model-11', ...discovered.slice(0, 9).map(model => model.id)])
    })
})

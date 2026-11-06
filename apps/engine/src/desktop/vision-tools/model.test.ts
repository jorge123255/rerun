import { describe, expect, it } from 'vitest'
import { desktopVisionModelFor, NO_VISION_MODEL } from './model'

const connection = (models: { id: string; images: boolean; price: { input: number; output: number; cacheRead: number | null }[] = []) => ({ id: 'oc-1', config: { provider: 'opencode', models: [], providerModels: models }, env: {} })

describe('selected OpenCode vision model', () => {
    it('keeps the selected provider and current seeing model', () => {
        expect(desktopVisionModelFor({ resolved: { provider: 'openai' } } as never)).toBeUndefined()
        const agent = { resolved: { provider: 'opencode', model: 'go/see', connection: connection([{ id: 'go/see', images: true, price: { input: 1, output: 2, cacheRead: null } }]) }
        expect(desktopVisionModelFor(agent as never)).toBeUndefined()
    })

    it('does not replace a selected model that cannot see images', () => {
        const agent = { resolved: { provider: 'opencode', model: 'go/blind', connection: connection([
            { id: 'go/blind', images: false, price: { input: 1, output: 1, cacheRead: null } },
            { id: 'go/expensive', images: true, price: { input: 5, output: 5, cacheRead: null } },
            { id: 'go/cheap', images: true, price: { input: 1, output: 1, cacheRead: null } },
            { id: 'console/seeing', images: true, price: { input: 0.1, output: 0.1, cacheRead: null } },
        ]) }
        expect(desktopVisionModelFor(agent as never)).toBeNull()
    })

    it('is honestly unavailable without a seeing model or catalog metadata', () => {
        const blind = { resolved: { provider: 'opencode', model: 'go/blind', connection: connection([{ id: 'go/blind', images: false, price: { input: 1, output: 1, cacheRead: null } }]) }
        expect(desktopVisionModelFor(blind as never)).toBeNull()
        expect(desktopVisionModelFor({ resolved: { provider: 'opencode', connection: connection() } } as never)).toBeNull()
        expect(NO_VISION_MODEL).toContain('None of the models switched on')
    })
})

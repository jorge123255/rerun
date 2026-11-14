import { expect, it } from 'vitest'
import { addressAllowed, createPinnedProviderFetch, endpointBase } from './network.js'
import { parseCustomModels } from './catalog.js'
import type { CustomProviderConfig } from '@rerun/contracts'
const config: CustomProviderConfig = { name: 'Local', baseUrl: 'http://localhost:11434/v1', preset: 'ollama', models: [{ id: 'exact:model', source: 'manual', contextWindow: null, vision: false }], contextWindow: null, vision: false, policy: { reviewedOrigin: 'http://localhost:11434', allowHttp: true, allowPrivate: true } }
it('retains exact model IDs and detects empty versus malformed catalogs', () => {
    expect(parseCustomModels({ data: [] })).toEqual([])
    expect(() => parseCustomModels({ error: 'not supported' })).toThrow()
    expect(parseCustomModels({ data: [{ id: 'vendor/model:tag', context_length: 32768 }, { id: 'vendor/model:tag' }] })).toEqual([{ id: 'vendor/model:tag', contextWindow: 32768, vision: false, source: 'discovered' }])
})
it('requires explicit local policy and never rewrites localhost to a Docker host', () => {
    expect(endpointBase(config)).toBe('http://localhost:11434/v1')
    expect(() => endpointBase({ ...config, policy: { ...config.policy, allowHttp: false } })).toThrow()
    expect(() => endpointBase({ ...config, baseUrl: 'http://localhost:1234/v1' })).toThrow()
    expect(() => endpointBase({ ...config, baseUrl: 'http://user:secret@localhost:11434/v1' })).toThrow()
})
it('blocks private DNS answers without a connection-specific review and always refuses metadata addresses', () => {
    expect(addressAllowed('127.0.0.1', false)).toBe(false)
    expect(addressAllowed('127.0.0.1', true)).toBe(true)
    expect(addressAllowed('169.254.169.254', true)).toBe(false)
    expect(addressAllowed('::ffff:127.0.0.1', true)).toBe(false)
    expect(addressAllowed('2001:db8::1', false)).toBe(false)
})

it('admits the xAI chat catalog only at the exact reviewed base and keeps it behind admission', async () => {
    const signal = new AbortController().signal
    const check = async () => { throw new Error('Fixture stops before DNS') }
    const baseUrl = 'https://api.x.ai/v1'
    const fetchXai = createPinnedProviderFetch({ ...config, baseUrl, preset: 'xai',
        policy: { reviewedOrigin: 'https://api.x.ai', allowHttp: false, allowPrivate: false } }, check, signal)
    await expect(fetchXai(baseUrl + '/language-models')).rejects.toThrow('Fixture stops before DNS')
    await expect(fetchXai(baseUrl + '/models')).rejects.toThrow('Custom endpoint request refused')
    await expect(fetchXai('https://unreviewed.example/v1/language-models')).rejects.toThrow('Custom endpoint request refused')
    const fetchLocal = createPinnedProviderFetch(config, check, signal)
    await expect(fetchLocal(config.baseUrl + '/language-models')).rejects.toThrow('Custom endpoint request refused')
})

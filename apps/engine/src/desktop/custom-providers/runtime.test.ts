import { expect, it } from 'vitest'
import { addressAllowed, endpointBase } from './network.js'
import { parseCustomModels } from './runtime.js'
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

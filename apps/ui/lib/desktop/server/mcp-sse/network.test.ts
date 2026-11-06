import { describe, expect, it, vi } from 'vitest'
import { createPinnedSseNetwork } from './network'
import { SseFailure } from './errors'
import type { SseAuthority } from './types'

// Every case refuses before native HTTPS. No fixture contacts any address.
const authority: SseAuthority = { server: { id: 'server', name: 'example', revision: 'rev', url: 'https://example.com/sse', transport: 'sse', hasBearer: true }, credentialGeneration: 'generation', credentialHandle: {}, check() {} }
describe('required pinned/public credential boundary', () => {
    it('does not read credentials when root public-address validation rejects DNS rebinding/private answers', async () => {
        const credential = vi.fn(async () => ({ bearer: 'fixture-token' }))
        const network = createPinnedSseNetwork({ resolvePublic: async () => { throw new SseFailure('unsupported') }, credential })
        await expect(network({ url: authority.server.url, method: 'GET', authority, signal: new AbortController().signal, guard: async () => {} })).rejects.toThrow()
        expect(credential).not.toHaveBeenCalled()
    })
    it('refuses malformed pins and credential changes before connecting', async () => {
        const credential = vi.fn(async () => ({ bearer: 'fixture-token' }))
        const network = createPinnedSseNetwork({ resolvePublic: async () => ({ address: 'not-an-ip', family: 4 }), credential })
        await expect(network({ url: authority.server.url, method: 'GET', authority, signal: new AbortController().signal, guard: async () => {} })).rejects.toThrow()
        expect(credential).not.toHaveBeenCalled()
        const other = createPinnedSseNetwork({ resolvePublic: async () => ({ address: '8.8.8.8', family: 4 }), credential })
        let guards = 0
        await expect(other({ url: authority.server.url, method: 'GET', authority, signal: new AbortController().signal,
            guard: async () => { if (++guards === 2) throw new SseFailure('changed') } })).rejects.toThrow()
        expect(guards).toBe(2)
    })
})

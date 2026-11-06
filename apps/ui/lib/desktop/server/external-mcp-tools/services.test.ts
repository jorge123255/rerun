import { expect, it, vi } from 'vitest'
import type { LocalServices } from '../services/lifecycle'
import type { ServiceStore } from '../services/store'
import { createExternalMcpServicesAuthority } from './services'

it('projects installed connectors through current canonical service authority without copying credential fields', async () => {
    const current = vi.fn(async () => ({}))
    const view = vi.fn(async () => ({ key: 'docs', slug: 'docs', name: 'Docs', status: 'active', revision: 'revision', toolNames: ['search'], configured: { apiKey: true } }))
    const record = { owner: 'local-owner', bearer: 'must never leave custody' }
    const service = createExternalMcpServicesAuthority({ services: { current, view } as unknown as LocalServices, store: { list: async () => [record] } as unknown as Pick<ServiceStore, 'list'> })
    const result = await service.listInstalled('local-owner', new AbortController().signal)
    expect(result).toEqual([{ key: 'docs', slug: 'docs', name: 'Docs', status: 'active', revision: 'revision', toolNames: ['search'] }])
    expect(current).toHaveBeenCalledTimes(2)
    expect(JSON.stringify(result)).not.toContain('apiKey')
    expect(JSON.stringify(result)).not.toContain('must never leave custody')
})

it('does not report an unknown canonical connector mutation as success', async () => {
    const mutate = vi.fn(async () => ({ status: 'unknown' }))
    const service = createExternalMcpServicesAuthority({ services: { mutate } as unknown as LocalServices, store: { list: async () => [] } as unknown as Pick<ServiceStore, 'list'> })
    await expect(service.mutate('owner', { action: 'remove', requestId: '11111111-1111-4111-8111-111111111111', key: 'docs', expectedRevision: '22222222-2222-4222-8222-222222222222' }, new AbortController().signal)).rejects.toThrow(/unknown/)
})

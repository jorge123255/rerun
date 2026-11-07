import { expect, it, vi } from 'vitest'
import { createDesktopMcpLoginRoute } from './route.js'

it('authenticates before reading a model payload or creating the service', async () => {
    const service = vi.fn()
    const route = createDesktopMcpLoginRoute({ authenticate: async () => { throw new Error('PRIVATE credential failure') }, service, watchOwner: () => () => {} })
    const response = await route(new Request('http://127.0.0.1/internal', { method: 'POST', body: '{}' }))
    expect(response.status).toBe(400)
    expect(await response.text()).not.toContain('PRIVATE')
    expect(service).not.toHaveBeenCalled()
})

it('rejects oversize input before any server probe', async () => {
    const service = vi.fn()
    const route = createDesktopMcpLoginRoute({ authenticate: async () => ({ workspace: 'a' }), service, watchOwner: () => () => {} })
    expect((await route(new Request('http://127.0.0.1/internal', { method: 'POST', body: 'x'.repeat(8193) }))).status).toBe(400)
    expect(service).not.toHaveBeenCalled()
})

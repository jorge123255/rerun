import { expect, it, vi } from 'vitest'
import { createDesktopCustomProviderApi } from './api'
import type { CustomProviderAuthority } from '@rerun/contracts'
import type { DesktopRuntime } from '../runtime'
vi.mock('server-only', () => ({}))
it('refuses another workspace before invoking any mutation, probe or credential authority', async () => {
    const change = vi.fn(), credential = vi.fn()
    const authority = { change, credential, subscribe: () => () => {} } as unknown as CustomProviderAuthority
    const api = createDesktopCustomProviderApi(authority)
    const response = await api.request({ workspaceId: 1 } as DesktopRuntime, new Request('http://localhost/owned', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'change', change: { action: 'disconnect', requestId: '11111111-1111-4111-8111-111111111111', identity: { workspaceId: 2, connectionId: 'custom', revision: 1 } } }) }))
    expect(response.status).toBe(403); expect(change).not.toHaveBeenCalled(); expect(credential).not.toHaveBeenCalled(); api.close()
})
it('never serializes validation input, keys or authority error text', async () => {
    const authority = { subscribe: () => () => {} } as unknown as CustomProviderAuthority
    const api = createDesktopCustomProviderApi(authority)
    const response = await api.request({ workspaceId: 1 } as DesktopRuntime, new Request('http://localhost/owned', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'unknown', apiKey: 'fixture-secret-not-a-real-key' }) }))
    expect(await response.text()).not.toContain('fixture-secret'); api.close()
})

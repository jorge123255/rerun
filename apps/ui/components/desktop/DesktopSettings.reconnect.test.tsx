// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import type { ConnectionsList, ConnectionSummary } from '@rerun/contracts'
import { expect, it, vi } from 'vitest'
import { DesktopSettings } from './DesktopSettings'

it('opens only the failed subscription, and closes its controls if the saved connection disappears', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    const kimi: ConnectionSummary = {
        id: 'mac-kimi-code-00000000-0000-4000-8000-000000000001', name: 'Kimi subscription', provider: 'kimi-code',
        models: ['kimi-fixture'], extraModels: [], connected: true, credentialRejected: true, planLimits: null, createdAt: '',
    }
    const sibling: ConnectionSummary = { ...kimi, id: 'mac-grok-build-00000000-0000-4000-8000-000000000002',
        name: 'Grok subscription', provider: 'grok-build', models: ['grok-fixture'], credentialRejected: false }
    const providers: ConnectionsList = { connections: [sibling, kimi], default: { connectionId: sibling.id, model: sibling.models[0]! } }
    const fetcher = vi.fn<typeof fetch>(async (url, init) => {
        expect(url).toBe('/api/desktop/subscription-login')
        expect(init?.method).toBe('GET')
        return Response.json({ 'kimi-code': { phase: 'idle' }, 'grok-build': { phase: 'idle' } })
    })
    vi.stubGlobal('fetch', fetcher)
    const host = document.body.appendChild(document.createElement('div'))
    const root = createRoot(host)
    const save = vi.fn()
    const show = (connections: ConnectionSummary[]) => act(async () => root.render(<DesktopSettings
        providers={{ ...providers, connections }} initialConnectionId={kimi.id} workspaceName="Offline fixture"
        onProviders={vi.fn()} onSave={save} />))
    try {
        await show(providers.connections)
        expect(host.textContent).toContain('Sign in with Kimi Code')
        expect(host.textContent).not.toContain('Sign in with Grok Build')
        expect(host.querySelector('#desktop-default')).toBeNull()
        expect(fetcher).toHaveBeenCalledTimes(1)
        await show([sibling])
        expect(host.textContent).toContain('This connection is no longer available.')
        expect(host.textContent).not.toContain('Sign in with Kimi Code')
        expect(host.textContent).not.toContain('Sign in with Grok Build')
        expect(host.querySelector('input[type="password"]')).toBeNull()
        expect(save).not.toHaveBeenCalled()
    } finally {
        await act(async () => root.unmount())
        host.remove()
        vi.unstubAllGlobals()
    }
})

// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import type { ConnectionsList, ConnectionSummary } from '@rerun/contracts'
import { expect, it, vi } from 'vitest'
import { DesktopSettings } from './DesktopSettings'

it('shows a saved named default without offering it as a writable default or a legacy key', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    const named: ConnectionSummary = {
        id: 'cnx_fixture-named', name: 'Named key', provider: 'openai', models: ['named-model'],
        extraModels: [], connected: true, credentialRejected: false, planLimits: null, createdAt: '',
    }
    const legacy: ConnectionSummary = { ...named, id: 'legacy-openai', name: 'Standard key', models: ['legacy-model'] }
    const host = document.body.appendChild(document.createElement('div'))
    const root = createRoot(host)
    const save = vi.fn(async () => {})
    const providers: ConnectionsList = { connections: [named, legacy], default: { connectionId: named.id, model: named.models[0]! } }
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (url, init) => {
        expect(init?.method).toBe('GET')
        if (url === '/api/desktop/subscription-login') return Response.json({ 'kimi-code': { phase: 'unavailable' }, 'grok-build': { phase: 'unavailable' } })
        expect(url).toBe('/api/desktop/api-connections/1/catalog')
        return Response.json({ version: 1, workspaceId: 1, default: providers.default, connections: [{
            version: 1, workspaceId: 1, connectionId: named.id, revision: 'rev_fixture-named', provider: named.provider,
            name: named.name, models: named.models, extraModels: [], connected: true, credentialRejected: false, createdAt: '2026-11-11T00:00:00Z',
        }] })
    }))
    try {
        await act(async () => root.render(<DesktopSettings providers={providers} workspaceName="Offline fixture" workspaceId={1} onProviders={vi.fn()} onSave={save} />))
        const model = host.querySelector<HTMLSelectElement>('#desktop-default')!
        const provider = host.querySelector<HTMLSelectElement>('#desktop-provider')!
        expect(model.selectedOptions[0]?.textContent).toContain('Saved default')
        expect(model.selectedOptions[0]?.textContent).toContain('named-model')
        expect(model.selectedOptions[0]?.disabled).toBe(true)
        expect(model.querySelector('optgroup[label="Named key"]')).toBeNull()
        expect(provider.value).toBe(legacy.id)
        expect([...provider.options].some(option => option.value === named.id)).toBe(false)
        expect(host.querySelector('[aria-label="Your API keys"]')?.textContent).toContain(named.name)
        expect(save).not.toHaveBeenCalled()
        const replacement = [...model.options].find(option => option.textContent === 'legacy-model')!
        await act(async () => {
            model.value = replacement.value
            model.dispatchEvent(new Event('change', { bubbles: true }))
        })
        expect(save).toHaveBeenCalledExactlyOnceWith({ action: 'default', connectionId: legacy.id, model: 'legacy-model' })
    } finally {
        await act(async () => root.unmount())
        host.remove()
        vi.unstubAllGlobals()
    }
})

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

it('offers local API keys in App Store mode without mounting subscription sign-in', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    const key: ConnectionSummary = {
        id: 'legacy-openai', name: 'Fixture API key', provider: 'openai', models: ['key-model'],
        extraModels: [], connected: true, credentialRejected: false, planLimits: null, createdAt: '',
    }
    const subscription: ConnectionSummary = { ...key, id: 'mac-chatgpt', provider: 'codex', name: 'Saved Codex', models: ['codex-model'] }
    const providers: ConnectionsList = { connections: [key, subscription], default: { connectionId: subscription.id, model: 'codex-model' } }
    const fetcher = vi.fn<typeof fetch>(async (url) => {
        expect(url).toBe('/api/desktop/api-connections/1/catalog')
        return Response.json({ version: 1, workspaceId: 1, default: null, connections: [] })
    })
    vi.stubGlobal('fetch', fetcher)
    const host = document.body.appendChild(document.createElement('div'))
    const root = createRoot(host)
    const save = vi.fn(async () => {})
    try {
        await act(async () => root.render(<DesktopSettings appStoreBuild providers={providers} workspaceName="Offline fixture"
            workspaceId={1} onProviders={vi.fn()} onSave={save} />))
        const model = host.querySelector<HTMLSelectElement>('#desktop-default')!
        const provider = host.querySelector<HTMLSelectElement>('#desktop-provider')!
        expect(host.textContent).toContain('Local subscription sign-in and native command tools require the direct Mac build.')
        expect([...provider.options].map(option => option.value)).not.toContain('add:claude')
        expect([...provider.options].map(option => option.value)).not.toContain('mac-chatgpt')
        expect([...provider.options].map(option => option.value)).toContain('add:custom')
        expect(fetcher.mock.calls.some(([url]) => String(url).includes('subscription-login'))).toBe(false)
        expect(model.querySelector('optgroup[label="Saved Codex"]')).toBeNull()
        expect(save).not.toHaveBeenCalled()
        const option = [...model.options].find(item => item.textContent === 'key-model')!
        await act(async () => {
            model.value = option.value
            model.dispatchEvent(new Event('change', { bubbles: true }))
        })
        expect(save).toHaveBeenCalledExactlyOnceWith({ action: 'default', connectionId: key.id, model: 'key-model' })
    } finally {
        await act(async () => root.unmount())
        host.remove()
        vi.unstubAllGlobals()
    }
})

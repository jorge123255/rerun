// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, test, vi } from 'vitest'
import type { DesktopServiceAccountView, DesktopServiceOAuthSnapshot } from '@rerun/contracts'
import type { ServiceOAuthDriver } from '@/lib/desktop/service-oauth-client'
import { DesktopServiceOAuthAccount } from './DesktopServiceOAuthAccount'
const roots: Root[] = []
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
afterEach(async () => { await act(async () => roots.splice(0).forEach(root => root.unmount())); document.body.innerHTML = '' })
const account: DesktopServiceAccountView = { key: 'fixture', slug: 'fixture', name: 'Fixture', icon: null, category: 'productivity', status: 'needs_auth', toolNames: [], authMethodId: 'oauth', installedAt: '2026-11-05T00:00:00.000Z', revision: '00000000-0000-4000-8000-000000000001', installationId: '00000000-0000-4000-8000-000000000002', health: { state: 'unchecked' }, shape: 'oauth', transport: 'http', headerPlan: [], configured: false, configuredInputs: {}, publicInputs: {} }
const snapshot: DesktopServiceOAuthSnapshot = { attemptId: '00000000-0000-4000-8000-000000000003', revision: '00000000-0000-4000-8000-000000000004', coworkerId: 'owner', installationId: account.installationId, accountKey: account.key, label: account.name, methodId: 'oauth', configGeneration: account.revision, state: 'checking', expiresAt: 300000, configured: true, installed: false, message: 'Sign-in saved. Check the connection.' }
function mount() { const root = createRoot(document.body.appendChild(document.createElement('div'))); roots.push(root); return root }
const button = (text: string) => [...document.querySelectorAll('button')].find(value => value.textContent === text)!
test('reopening a saved OAuth account reads only current state and leaves readiness explicit', async () => {
    const action = vi.fn<ServiceOAuthDriver['action']>(async () => snapshot), root = mount()
    await act(async () => root.render(<DesktopServiceOAuthAccount coworkerId="owner" account={account} driver={{ action }} />))
    expect(action).toHaveBeenCalledTimes(1)
    expect(action.mock.calls[0]?.[1]).toEqual({ action: 'current', accountKey: account.key })
    expect(document.body.textContent).toContain('Sign-in saved. Check the connection.')
    expect(button('Check connection')).toBeDefined()
})
test('an absent attempt does not configure or open a browser until the user chooses Connect', async () => {
    const action = vi.fn<ServiceOAuthDriver['action']>(async (_owner, input) => { if (input.action === 'current') throw Error('no attempt'); return { ...snapshot, state: 'configured' } }), root = mount()
    await act(async () => root.render(<DesktopServiceOAuthAccount coworkerId="owner" account={account} driver={{ action }} />))
    expect(action).toHaveBeenCalledTimes(1)
    await act(async () => button('Connect').click())
    expect(action).toHaveBeenCalledTimes(2)
    expect(action.mock.calls[1]?.[1]).toMatchObject({ action: 'configure', methodId: 'oauth', intent: { kind: 'existing', accountKey: account.key, expectedRevision: account.revision } })
})
test('a delayed current read from the old owner cannot replace the selected account', async () => {
    let finish!: (value: DesktopServiceOAuthSnapshot) => void
    const action = vi.fn<ServiceOAuthDriver['action']>((owner) => owner === 'owner' ? new Promise(resolve => { finish = resolve }) : Promise.resolve({ ...snapshot, coworkerId: owner, message: 'Current owner sign-in' })), driver = { action }, root = mount()
    await act(async () => root.render(<DesktopServiceOAuthAccount coworkerId="owner" account={account} driver={driver} />))
    await act(async () => root.render(<DesktopServiceOAuthAccount coworkerId="next" account={account} driver={driver} />))
    await act(async () => finish(snapshot))
    expect(document.body.textContent).toContain('Current owner sign-in')
    expect(document.body.textContent).not.toContain('Sign-in saved. Check the connection.')
})

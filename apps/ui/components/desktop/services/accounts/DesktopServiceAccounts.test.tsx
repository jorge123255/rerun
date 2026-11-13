// @vitest-environment happy-dom
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { DesktopServiceAccountsClient, ServiceAccountDetail, ServiceAccountLibraryRow } from '@/lib/desktop/service-accounts-client'
import type { DesktopServiceAccountView } from '@rerun/contracts'

const state = vi.hoisted(() => ({
    installed: vi.fn<DesktopServiceAccountsClient['installed']>(async () => []),
    catalog: vi.fn(async () => ({ total: 0, services: [] as ServiceAccountLibraryRow[] })),
    detail: vi.fn<DesktopServiceAccountsClient['detail']>(async () => { throw new Error('detail') }),
    reconfigure: vi.fn<DesktopServiceAccountsClient['reconfigure']>(),
    dispose: vi.fn(),
}))
vi.mock('@/lib/desktop/service-accounts-client', () => ({ createDesktopServiceAccountsClient: () => state }))
vi.mock('@/components/ui/panel-steps', () => ({ PanelSteps: ({ children }: { children: ReactNode }) => children }))
import { DesktopServiceAccounts } from './DesktopServiceAccounts'
import { DesktopCoworkerServices } from '../DesktopCoworkerServices'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const roots: Array<{ root: Root; host: HTMLElement }> = []
const agentId = '00000000-0000-4000-8000-000000000001'
const vaultRequest = vi.fn<typeof fetch>()
beforeEach(() => {
    vaultRequest.mockReset().mockResolvedValue(Response.json({ agentId, attached: [], available: [] }))
    vi.stubGlobal('fetch', vaultRequest)
})
afterEach(() => { vi.unstubAllGlobals() })
afterEach(() => { for (const { root, host } of roots.splice(0)) { act(() => root.unmount()); host.remove() }; state.detail.mockReset(); state.installed.mockReset().mockResolvedValue([]); state.reconfigure.mockReset() })

function row(installStatus: ServiceAccountLibraryRow['installStatus'], multiInstance: boolean, addAccount: boolean): ServiceAccountLibraryRow {
    return { slug: 'fixture', name: 'Fixture', category: 'dev', summary: 'Summary', icon: null, verified: true, requiresSecrets: true, setup: 'needs_config', setupReason: 'Choose a supported local method.', installed: installStatus === 'active', installStatus, multiInstance, addAccount, authMethods: [], methodAvailability: [] }
}

async function render(services: ServiceAccountLibraryRow[]) {
    state.catalog.mockResolvedValue({ total: services.length, services })
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    roots.push({ root, host })
    act(() => root.render(<DesktopServiceAccounts agentId="coworker-1" />))
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 250)) })
    return host
}

it('uses the original empty copy and shows Add account only for an active multi-instance app the feature allows', async () => {
    const empty = await render([])
    expect(empty.querySelector('input')?.getAttribute('placeholder')).toBe('Search apps…')
    expect(empty.textContent).toContain('No apps installed')
    expect(empty.textContent).toContain('No apps found')
    const inactive = await render([row('needs_config', true, false)])
    expect([...inactive.querySelectorAll('button')].some(button => button.textContent === 'Add account')).toBe(false)
    const blocked = await render([row('active', true, false)])
    expect([...blocked.querySelectorAll('button')].some(button => button.textContent === 'Add account')).toBe(false)
    expect(state.detail).not.toHaveBeenCalled()
    const allowed = await render([row('active', true, true)])
    const allowedButton = [...allowed.querySelectorAll('button')].find(button => button.textContent === 'Add account')!
    await act(async () => { allowedButton.click() })
    expect(state.detail).toHaveBeenCalledWith('fixture')
})

function installed(): DesktopServiceAccountView {
    return { key: 'fixture', slug: 'fixture', label: 'Fixture account', name: 'Fixture', category: 'dev', icon: null, status: 'needs_config', toolNames: [], authMethodId: 'default', installedAt: '2026-01-01T00:00:00.000Z', revision: '00000000-0000-4000-8000-000000000010', health: { state: 'unchecked' }, installationId: '00000000-0000-4000-8000-000000000011', shape: 'anonymous', headerPlan: [], configured: true, configuredInputs: {}, publicInputs: {} }
}
function details(): ServiceAccountDetail {
    return { slug: 'fixture', name: 'Fixture', category: 'dev', icon: null, summary: 'Summary', description: 'Fixture description', multiInstance: true, accounts: [installed()], localLimitations: 'Local setup', methodAvailability: [{ id: 'default', supported: true }], authMethods: [{ id: 'default', label: 'No sign-in', kind: 'none', recommended: true, inputs: [], requiresSecrets: false, availability: { id: 'default', supported: true } }] }
}
it('mounts account setup through the existing Apps entry and keeps chat focus when the catalog finishes later', async () => {
    state.detail.mockResolvedValue(details())
    state.catalog.mockResolvedValue({ total: 0, services: [] })
    const host = document.createElement('div'); document.body.append(host)
    const root = createRoot(host); roots.push({ root, host })
    await act(async () => { root.render(<DesktopCoworkerServices agentId={agentId} focusSlug="fixture" focusRequestKey="chat-request-1" />) })
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 250)) })
    expect(state.detail).toHaveBeenCalledWith('fixture')
    expect(host.textContent).toContain('Fixture account')
    expect(host.querySelector('[data-account-key]')?.getAttribute('data-account-key')).toBe(`${installed().installationId}/${installed().revision}`)
    expect([...host.querySelectorAll('button')].some(button => button.textContent === 'Save')).toBe(true)
})
it('Finish setup selects the saved account and blocks other account actions during its save', async () => {
    state.detail.mockResolvedValue(details())
    const host = await render([row('needs_config', true, false)])
    await act(async () => { [...host.querySelectorAll('button')].find(button => button.textContent === 'Finish setup')!.click() })
    expect(host.querySelector('[data-account-key]')?.getAttribute('data-account-key')).toBe(`${installed().installationId}/${installed().revision}`)
    let finish!: () => void
    state.reconfigure.mockImplementation(() => new Promise(resolve => { finish = () => resolve({ status: 'needs_config', accountKey: 'fixture' }) }))
    await act(async () => { [...host.querySelectorAll('button')].find(button => button.textContent === 'Save')!.click() })
    expect([...host.querySelectorAll('button')].find(button => button.textContent === 'Disconnect')?.disabled).toBe(true)
    expect([...host.querySelectorAll('button')].find(button => button.textContent === 'Probe connection')?.disabled).toBe(true)
    expect(state.reconfigure).toHaveBeenCalledWith('fixture', installed().revision, 'default', {})
    await act(async () => { finish() })
})

it('adds and removes assigned secrets from the Apps list and explains shared entries', async () => {
    const item = { id: '00000000-0000-4000-8000-000000000002', revision: '00000000-0000-4000-8000-000000000003', name: 'Release key', variable: 'RELEASE_KEY', sharedWithAll: false }
    const shared = { ...item, id: '00000000-0000-4000-8000-000000000004', name: 'Team key', sharedWithAll: true }
    const saved = { ...item, revision: '00000000-0000-4000-8000-000000000005' }
    vaultRequest
        .mockResolvedValueOnce(Response.json({ agentId, attached: [shared], available: [item] }))
        .mockResolvedValueOnce(Response.json({ agentId, attached: [shared, saved], available: [] }))
        .mockResolvedValueOnce(Response.json({ agentId, attached: [shared], available: [item] }))
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    roots.push({ root, host })
    await act(async () => { root.render(<DesktopServiceAccounts agentId={agentId} />) })
    const button = (label: string) => host.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)
    expect(host.textContent).toContain('Shared with every coworker')
    expect(button('Remove Team key')?.disabled).toBe(true)
    expect(host.textContent).toContain('From the Vault')
    await act(async () => { button('Add Release key')!.click() })
    expect(button('Add Release key')).toBeNull()
    const url = `/api/desktop/coworkers/${agentId}/vault`
    expect(vaultRequest).toHaveBeenLastCalledWith(url, expect.objectContaining({
        method: 'POST', body: JSON.stringify({ id: item.id, revision: item.revision, attached: true }),
    }))
    await act(async () => { button('Remove Release key')!.click() })
    expect(vaultRequest).toHaveBeenLastCalledWith(url, expect.objectContaining({
        method: 'POST', body: JSON.stringify({ id: item.id, revision: saved.revision, attached: false }),
    }))
    expect(button('Add Release key')).not.toBeNull()
})

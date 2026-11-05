// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import type { ServiceAccountLibraryRow } from '@/lib/desktop/service-accounts-client'

const state = vi.hoisted(() => ({
    installed: vi.fn(async () => []),
    catalog: vi.fn(async () => ({ total: 0, services: [] as ServiceAccountLibraryRow[] })),
    detail: vi.fn(async () => { throw new Error('detail') }),
    dispose: vi.fn(),
}))
vi.mock('@/lib/desktop/service-accounts-client', () => ({ createDesktopServiceAccountsClient: () => state }))
import { DesktopServiceAccounts } from './DesktopServiceAccounts'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const roots: Array<{ root: Root; host: HTMLElement }> = []
afterEach(() => { for (const { root, host } of roots.splice(0)) { act(() => root.unmount()); host.remove() }; state.detail.mockClear() })

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
    const blockedButton = [...blocked.querySelectorAll('button')].find(button => button.textContent === 'Add account')!
    await act(async () => { blockedButton.click() })
    expect(state.detail).not.toHaveBeenCalled()
    const allowed = await render([row('active', true, true)])
    const allowedButton = [...allowed.querySelectorAll('button')].find(button => button.textContent === 'Add account')!
    await act(async () => { allowedButton.click() })
    expect(state.detail).toHaveBeenCalledWith('fixture')
})

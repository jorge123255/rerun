// @vitest-environment happy-dom
// Source-only regressions; root runs validation.
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, test, vi } from 'vitest'
import { DesktopWorkspaceSwitcher } from './DesktopWorkspaceSwitcher'
import type { DesktopWorkspaceClient } from '@/lib/desktop/workspaces'
import type { DesktopWorkspaceListResult, DesktopWorkspaceRecord } from '@rerun/contracts'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }))

const workspace = (id: number, name: string): DesktopWorkspaceRecord => ({
    workspaceId: id,
    name,
    iconCatalogId: null,
    directoryName: String(id),
    createdAt: '2026-11-05T00:00:00.000Z',
    updatedAt: '2026-11-05T00:00:00.000Z',
    pathStatus: 'ready',
})

function listResult(active: number, workspaces: DesktopWorkspaceRecord[], openReceipt: DesktopWorkspaceListResult['openReceipt'] = null): DesktopWorkspaceListResult {
    return {
        catalog: { version: 1, installId: '00000000-0000-4000-8000-000000000001', workspaces },
        selection: {
            version: 1,
            workspaceId: active,
            publishedByReceiptId: null,
            selectedAt: '2026-11-05T00:00:00.000Z',
        },
        openReceipt,
    }
}

const roots: Root[] = []
afterEach(() => {
    for (const root of roots.splice(0)) {
        act(() => { root.unmount() })
    }
    document.body.innerHTML = ''
})

function mount(node: ReactNode) {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    roots.push(root)
    act(() => { root.render(node) })
    return host
}

test('lists local workspaces and New workspace entry', async () => {
    const workspaces = [workspace(1, 'My workspace'), workspace(2, 'Acme')]
    const client: DesktopWorkspaceClient = {
        list: vi.fn(async () => listResult(1, workspaces)),
        create: vi.fn(),
        rename: vi.fn(),
        switchTo: vi.fn(),
    }
    mount(<DesktopWorkspaceSwitcher client={client} profileLabel="Local" />)
    await act(async () => { await Promise.resolve() })
    expect(client.list).toHaveBeenCalled()
    const trigger = document.querySelector<HTMLButtonElement>('[aria-label^="Workspace menu"]')
    expect(trigger).toBeTruthy()
    await act(async () => { trigger!.click() })
    expect(document.body.textContent).toContain('My workspace')
    expect(document.body.textContent).toContain('Acme')
    expect(document.body.textContent).toContain('New workspace')
})

test('blocked open receipt explains busy switch in product language', async () => {
    const workspaces = [workspace(1, 'My workspace'), workspace(2, 'Acme')]
    const switchTo = vi.fn()
    const client: DesktopWorkspaceClient = {
        list: vi.fn(async () => listResult(1, workspaces, {
            version: 1,
            receiptId: '00000000-0000-4000-8000-0000000000aa',
            requestId: '00000000-0000-4000-8000-0000000000bb',
            fromWorkspaceId: 1,
            toWorkspaceId: 2,
            phase: 'target_starting',
            installId: '00000000-0000-4000-8000-000000000001',
            createdAt: '2026-11-05T00:00:00.000Z',
            updatedAt: '2026-11-05T00:00:00.000Z',
            reason: null,
            admissionsFrozen: true,
            oldRuntimeClosed: true,
        })),
        create: vi.fn(),
        rename: vi.fn(),
        switchTo,
    }
    mount(<DesktopWorkspaceSwitcher client={client} />)
    await act(async () => { await Promise.resolve() })
    const trigger = document.querySelector<HTMLButtonElement>('[aria-label^="Workspace menu"]')!
    await act(async () => { trigger.click() })
    expect(document.body.textContent).toMatch(/workspace switch is already in progress/i)
    expect(switchTo).not.toHaveBeenCalled()
})

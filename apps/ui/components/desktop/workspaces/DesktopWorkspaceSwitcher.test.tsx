// @vitest-environment happy-dom
// Source-only regressions; root runs validation.
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, test, vi } from 'vitest'
import { DropdownMenuItem } from '@/components/ui/dropdown-menu'
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

async function openMenu(trigger: HTMLElement) {
    await act(async () => {
        trigger.focus()
        trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }))
    })
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 1)) })
    expect(document.querySelector('[role="menu"]')).toBeTruthy()
}
const menuItem = (label: string) => [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(item => item.textContent?.trim() === label)

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
    await openMenu(trigger!)
    expect(document.body.textContent).toContain('My workspace')
    expect(menuItem('Acme')).toBeTruthy()
    expect(menuItem('New workspace')).toBeTruthy()
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
    await openMenu(trigger)
    expect(document.body.textContent).toMatch(/workspace switch is already in progress/i)
    expect(menuItem('Acme')?.getAttribute('aria-disabled')).toBe('true')
    await act(async () => { menuItem('Acme')!.click() })
    expect(switchTo).not.toHaveBeenCalled()
})

test('active saved metadata and the existing menu actions remain visible while the native catalog is unavailable', async () => {
    const onBoard = vi.fn()
    const client: DesktopWorkspaceClient = { list: vi.fn(async () => { throw new Error('unavailable') }), create: vi.fn(), rename: vi.fn(), switchTo: vi.fn() }
    mount(<DesktopWorkspaceSwitcher client={client} activeDisplay={{ name: 'Saved legacy name', iconCatalogId: null, iconUploadId: null }} menuItems={<DropdownMenuItem onSelect={onBoard}>Existing team board</DropdownMenuItem>} />)
    await act(async () => { await Promise.resolve() })
    const trigger = document.querySelector<HTMLButtonElement>('[aria-label="Workspace menu, Saved legacy name"]')
    expect(trigger).toBeTruthy()
    await openMenu(trigger!)
    expect(document.body.textContent).toContain('Existing team board')
    await act(async () => { menuItem('Existing team board')!.click() })
    expect(onBoard).toHaveBeenCalledOnce()
})

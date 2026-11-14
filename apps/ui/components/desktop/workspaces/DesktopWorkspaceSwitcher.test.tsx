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
    // The other workspaces hang off the menu's header.
    const header = document.querySelector<HTMLElement>('[data-testid="desktop-workspace-list-trigger"]')
    expect(header).toBeTruthy()
    await act(async () => {
        header!.focus()
        header!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }))
    })
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 1)) })
    expect(document.querySelector('[data-testid="desktop-workspace-list"]')).toBeTruthy()
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

test('keeps a confirmed workspace available to open when the catalog cannot be reread', async () => {
    const original = workspace(1, 'My workspace')
    const created = workspace(2, 'Acme')
    const list = vi.fn<DesktopWorkspaceClient['list']>()
        .mockResolvedValueOnce(listResult(1, [original]))
        .mockRejectedValue(new Error('Catalog temporarily unavailable'))
    const create = vi.fn<DesktopWorkspaceClient['create']>().mockResolvedValue({ ok: true, workspace: created, switched: false })
    const switchTo = vi.fn<DesktopWorkspaceClient['switchTo']>().mockResolvedValue({ ok: false, code: 'busy', message: 'Switch is busy.' })
    const client: DesktopWorkspaceClient = { list, create, rename: vi.fn(), switchTo }
    mount(<DesktopWorkspaceSwitcher client={client} />)
    await act(async () => { await Promise.resolve() })
    const trigger = document.querySelector<HTMLButtonElement>('[aria-label^="Workspace menu"]')!
    await openMenu(trigger)
    await act(async () => { menuItem('New workspace')!.click() })
    const input = document.querySelector<HTMLInputElement>('[role="dialog"] input')!
    await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, created.name)
        input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    const submit = () => document.querySelector<HTMLButtonElement>('[role="dialog"] button[type="submit"]')!
    await act(async () => { submit().click() })
    await act(async () => { submit().click() })

    expect(create).toHaveBeenCalledOnce()
    expect(switchTo).toHaveBeenCalledExactlyOnceWith({ requestId: expect.any(String), workspaceId: 2 })
    await openMenu(trigger)
    const retry = menuItem(created.name)
    expect(retry).toBeTruthy()
    await act(async () => { retry!.click() })
    expect(switchTo).toHaveBeenCalledTimes(2)
    expect(switchTo).toHaveBeenLastCalledWith({ requestId: expect.any(String), workspaceId: 2 })
    expect(create).toHaveBeenCalledOnce()
})

test('allows editing after a busy refusal and checks the same request after a lost create response', async () => {
    const original = workspace(1, 'My workspace')
    const saved = workspace(2, 'Revised workspace')
    const create = vi.fn<DesktopWorkspaceClient['create']>()
        .mockResolvedValueOnce({ ok: false, code: 'busy', message: 'Switch is busy.' })
        .mockRejectedValueOnce(new Error('Reply lost after saving'))
        .mockResolvedValueOnce({ ok: true, workspace: saved, switched: false })
    const switchTo = vi.fn<DesktopWorkspaceClient['switchTo']>().mockResolvedValue({ ok: false, code: 'busy', message: 'Switch is busy.' })
    const client: DesktopWorkspaceClient = { list: async () => listResult(1, [original]), create, rename: vi.fn(), switchTo }
    mount(<DesktopWorkspaceSwitcher client={client} />)
    await act(async () => { await Promise.resolve() })
    await openMenu(document.querySelector<HTMLButtonElement>('[aria-label^="Workspace menu"]')!)
    await act(async () => { menuItem('New workspace')!.click() })

    const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]')!
    const click = async (text: string) => {
        const button = [...dialog().querySelectorAll('button')].find(item => item.textContent?.trim() === text)
        expect(button, text).toBeDefined()
        await act(async () => { button!.click() })
    }
    async function name(value: string) {
        const input = dialog().querySelector('input')!
        await act(async () => {
            Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
            input.dispatchEvent(new Event('input', { bubbles: true }))
        })
    }

    await name('First name')
    await click('Continue')
    await click('Create workspace')
    expect(dialog().querySelector('[role="alert"]')?.textContent).toBe('Switch is busy.')
    await click('Back')
    await name(saved.name)
    await click('Continue')
    await click('Create workspace')
    expect(create).toHaveBeenCalledTimes(2)
    const [revisedRequest] = create.mock.calls[1]!
    expect(revisedRequest.name).toBe(saved.name)
    expect(revisedRequest.requestId).not.toBe(create.mock.calls[0]![0].requestId)
    expect(dialog().querySelector('[role="alert"]')?.textContent).toMatch(/could not confirm/i)
    expect(dialog().querySelectorAll('button[aria-pressed]:disabled').length).toBeGreaterThan(0)
    expect([...dialog().querySelectorAll('button')].some(button => button.textContent === 'Back')).toBe(false)

    await click('Check creation')
    expect(create).toHaveBeenCalledTimes(3)
    expect(create).toHaveBeenLastCalledWith(revisedRequest)
    expect(switchTo).toHaveBeenCalledExactlyOnceWith({ requestId: expect.any(String), workspaceId: saved.workspaceId })
})

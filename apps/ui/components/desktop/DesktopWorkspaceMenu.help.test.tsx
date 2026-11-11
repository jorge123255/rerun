// @vitest-environment happy-dom
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, test, vi } from 'vitest'
import type { DesktopWorkspaceClient } from '@/lib/desktop/workspaces'
import type { DesktopWorkspaceListResult, DesktopWorkspaceRecord } from '@rerun/contracts'
import { DesktopWorkspaceMenu } from './DesktopWorkspaceMenu'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const workspace = (id: number, name: string): DesktopWorkspaceRecord => ({
    workspaceId: id, name, iconCatalogId: null, directoryName: String(id),
    createdAt: '2026-11-05T00:00:00.000Z', updatedAt: '2026-11-05T00:00:00.000Z', pathStatus: 'ready',
})
const listed: DesktopWorkspaceListResult = {
    catalog: { version: 1, installId: '00000000-0000-4000-8000-000000000001', workspaces: [workspace(1, 'Studio')] },
    selection: { version: 1, workspaceId: 1, publishedByReceiptId: null, selectedAt: '2026-11-05T00:00:00.000Z' },
    openReceipt: null,
}
const client: DesktopWorkspaceClient = { list: vi.fn(async () => listed), create: vi.fn(), rename: vi.fn(), switchTo: vi.fn() }
vi.mock('@/lib/desktop/workspaces', async importOriginal => {
    const actual = await importOriginal<typeof import('@/lib/desktop/workspaces')>()
    return { ...actual, createDesktopWorkspaceClient: () => client }
})
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }))

const roots: Root[] = []
afterEach(() => {
    for (const root of roots.splice(0)) act(() => { root.unmount() })
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
const menu = (onHelp = vi.fn(), navigationDisabled = false) => mount(<DesktopWorkspaceMenu workspaceName="Studio" profileName="Local" agents={[]} selected={null} onBoard={vi.fn()} onCoworker={vi.fn()} onSettings={vi.fn()} onHelp={onHelp} navigationDisabled={navigationDisabled} />)

test('Help is its own control beside the workspace menu and is not buried in that menu', async () => {
    const onHelp = vi.fn()
    const host = menu(onHelp)
    await act(async () => { await Promise.resolve() })
    const help = host.querySelector<HTMLButtonElement>('button[aria-label="Help"]')
    const pill = host.querySelector<HTMLButtonElement>('[aria-label^="Workspace menu"]')
    expect(help).toBeTruthy()
    expect(pill).toBeTruthy()
    expect(help!.compareDocumentPosition(pill!) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(0)
    await act(async () => { help!.click() })
    expect(onHelp).toHaveBeenCalledOnce()
    pill!.focus()
    await act(async () => { pill!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })) })
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 1)) })
    const items = [...document.querySelectorAll('[role="menuitem"]')].map(item => item.textContent?.trim())
    expect(items).not.toContain('Help')
})

test('a blocked workspace navigation disables the Help control', async () => {
    const onHelp = vi.fn()
    const host = menu(onHelp, true)
    await act(async () => { await Promise.resolve() })
    const help = host.querySelector<HTMLButtonElement>('button[aria-label="Help"]')!
    expect(help.disabled).toBe(true)
    await act(async () => { help.click() })
    expect(onHelp).not.toHaveBeenCalled()
})

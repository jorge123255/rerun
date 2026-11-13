// @vitest-environment happy-dom
import { act, useState, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, test, vi } from 'vitest'
import type { DesktopWorkspaceClient } from '@/lib/desktop/workspaces'
import { desktopMessages, type DesktopLanguage } from '@/lib/desktop/locale'
import type { DesktopWorkspaceListResult, DesktopWorkspaceRecord } from '@rerun/contracts'
import { loadMessages } from '@rerun/i18n/messages'
import { publishDesktopGettingStartedAvailability } from '@/lib/desktop/help/availability'
import { DesktopLocale } from './DesktopLocale'
import { DesktopShortcutsDialog } from './DesktopShortcutsDialog'
import { DesktopWorkspaceMenu } from './DesktopWorkspaceMenu'
import { DesktopHelpDialog } from './help/DesktopHelpDialog'

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
    publishDesktopGettingStartedAvailability(null)
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
function menu(onHelp = vi.fn(), navigationDisabled = false, language?: DesktopLanguage) {
    const workspaceMenu = <DesktopWorkspaceMenu workspaceName="Studio" profileName="Local" agents={[]} selected={null} onBoard={vi.fn()} onCoworker={vi.fn()} onSettings={vi.fn()} onHelp={onHelp} navigationDisabled={navigationDisabled} />
    return mount(language ? <DesktopLocale initial={language}>{workspaceMenu}</DesktopLocale> : workspaceMenu)
}

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
    expect(onHelp).toHaveBeenCalledExactlyOnceWith(help)
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

test('the standalone control uses the shared Help label in French', async () => {
    const onHelp = vi.fn()
    const host = menu(onHelp, false, { preference: 'fr', locale: 'fr', messages: desktopMessages('fr', await loadMessages('fr')) })
    await act(async () => { await Promise.resolve() })
    const help = host.querySelector<HTMLButtonElement>('button[aria-label="Aide"]')
    expect(help).toBeTruthy()
    await act(async () => { help!.click() })
    expect(onHelp).toHaveBeenCalledExactlyOnceWith(help)
})

test.each(['fr', 'es', 'de', 'pt'] as const)('Help opens the mounted Mac shortcut list in %s', async locale => {
    const source = await loadMessages(locale)
    const language: DesktopLanguage = { preference: locale, locale, messages: desktopMessages(locale, source) }
    const labels = source.layout.menu
    const shortcuts = source.dialogs.shortcuts
    publishDesktopGettingStartedAvailability(1)

    function Dialogs() {
        const [dialog, setDialog] = useState<'help' | 'shortcuts' | null>('help')
        return <>
            <DesktopHelpDialog open={dialog === 'help'} onOpenChange={() => setDialog(null)} workspaceId={1}
                onGettingStarted={vi.fn()} onShortcuts={() => setDialog('shortcuts')} />
            <DesktopShortcutsDialog open={dialog === 'shortcuts'} onOpenChange={() => setDialog(null)} />
        </>
    }

    mount(<DesktopLocale initial={language}><Dialogs /></DesktopLocale>)
    const help = document.querySelector('[role="dialog"]')!
    expect(help.querySelector('[data-slot="dialog-title"]')?.textContent).toBe(source.layout.help.label)
    expect(help.querySelector('[data-slot="dialog-close"]')?.textContent).toBe(source.kit.close)
    expect([...help.querySelectorAll('a')].map(link => link.textContent?.trim())).toEqual([labels.docs, labels.community, labels.hireExpert])
    expect(help.textContent).toContain(labels.gettingStarted)
    const showShortcuts = [...help.querySelectorAll('button')].find(button => button.textContent?.trim() === labels.shortcuts)!
    await act(async () => { showShortcuts.click() })

    const opened = document.querySelector('[role="dialog"]')!
    expect(opened.querySelector('[data-slot="dialog-title"]')?.textContent).toBe(shortcuts.title)
    expect(opened.querySelector('[data-slot="dialog-close"]')?.textContent).toBe(source.kit.close)
    for (const action of [shortcuts.actions.controlCenter, shortcuts.actions.newConversation,
        shortcuts.actions.sendMessage, shortcuts.actions.previousFile, shortcuts.actions.nextFile]) {
        expect(opened.textContent).toContain(action)
    }
    expect(opened.textContent).toContain(language.messages.controlCenterOutsideInput)
    expect(opened.textContent).toContain(language.messages.closeTabOutsideInput)
    expect(opened.textContent).not.toContain(shortcuts.actions.askRerun)
})

test('the Vault menu row marks an app waiting on a sign-in, read again each time the menu opens', async () => {
    const entry = { id: '00000000-0000-4000-8000-0000000000a1', revision: '00000000-0000-4000-8000-0000000000a2', name: 'linear', kind: 'mcp',
        url: 'https://mcp.linear.app/mcp', hasBearer: false, browserSignIn: true, agentIds: [], sharedWithAll: false }
    let signedOut = false
    const fetched = vi.fn(async () => Response.json({ entries: [signedOut ? { ...entry, signedOut: true } : entry], coworkers: [] }))
    vi.stubGlobal('fetch', fetched)
    try {
        const open = async () => {
            const host = mount(<DesktopWorkspaceMenu workspaceName="Studio" profileName="Local" agents={[]} selected={null} onBoard={vi.fn()} onCoworker={vi.fn()} onSettings={vi.fn()} onVault={vi.fn()} />)
            await act(async () => { await new Promise(resolve => setTimeout(resolve, 1)) })
            const pill = host.querySelector<HTMLButtonElement>('[aria-label^="Workspace menu"]')!
            pill.focus()
            await act(async () => { pill.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })) })
            await act(async () => { await new Promise(resolve => setTimeout(resolve, 5)) })
            return [...document.querySelectorAll('[role="menuitem"]')].find(item => item.textContent?.trim() === 'Vault')!
        }
        const row = await open()
        // Once on mount and once more as the menu opens.
        expect(fetched).toHaveBeenCalledTimes(2)
        expect(fetched).toHaveBeenLastCalledWith('/api/desktop/vault', { cache: 'no-store' })
        expect(row.querySelector('[aria-label="An app of the Vault is signed out"]')).toBeNull()
        for (const root of roots.splice(0)) act(() => { root.unmount() })
        document.body.innerHTML = ''
        signedOut = true
        const marked = await open()
        expect(marked.querySelector('[aria-label="An app of the Vault is signed out"]')).toBeTruthy()
    } finally { vi.unstubAllGlobals() }
})

test('a menu without the Vault never reads it', async () => {
    const fetched = vi.fn()
    vi.stubGlobal('fetch', fetched)
    try {
        menu()
        await act(async () => { await new Promise(resolve => setTimeout(resolve, 1)) })
        expect(fetched).not.toHaveBeenCalled()
    } finally { vi.unstubAllGlobals() }
})

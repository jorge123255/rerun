// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { DesktopLocale } from './DesktopLocale'
import { desktopMessages, englishDesktopLanguage, type DesktopLanguage } from '@/lib/desktop/locale'
import { loadMessages } from '@rerun/i18n/messages'
import { DesktopApp, type DesktopAgentView } from './DesktopApp'
import type { GridPosition } from '@rerun/ui/iso-grid'
import { createDesktopDraftFixture } from '@/test/desktop-draft-fixture'
import { createDesktopRecentFixture } from '@/test/desktop-recent-fixture'
import { desktopBackgroundRead } from '@/test/desktop-background-fixture'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const researcher = { id: 'researcher', name: 'Researcher', description: '', createdAt: '2026-01-01', updatedAt: '' }
const editor = { ...researcher, id: 'editor', name: 'Editor', createdAt: '2026-01-02' }
const session = { id: 'saved', agentId: researcher.id, title: 'Original conversation', createdAt: '', updatedAt: '' }
let root: Root

afterEach(async () => {
    await act(async () => { root?.unmount() })
    document.body.innerHTML = ''
    vi.unstubAllGlobals()
})

type DuplicateInput = { requestId: string; position: GridPosition }
const copy = { ...researcher, id: 'independent', name: 'Researcher copy', createdAt: 'later' }
async function mount(options: {
    duplicate?: (input: DuplicateInput) => Response | Promise<Response>
    refreshedAgents?: () => DesktopAgentView[]
    agents?: DesktopAgentView[]
    language?: DesktopLanguage
    enabled?: (id: string, enabled: boolean) => Response | Promise<Response>
    remove?: (id: string, confirmationName: string) => Response | Promise<Response>
} = {}) {
    const drafts = createDesktopDraftFixture()
    const recent = createDesktopRecentFixture()
    let rejectNext = false
    const requests = vi.fn(async (url: string, init?: RequestInit) => {
        const recentResponse = recent.handle(url, init)
        if (recentResponse) return recentResponse
        const draftResponse = drafts.handle(url, init)
        if (draftResponse) return draftResponse
        if (url.endsWith('/approvals') && (init?.method ?? 'GET') === 'GET') return Response.json({ approval: null })
        if (url.endsWith('/questions') && (init?.method ?? 'GET') === 'GET') return Response.json({ question: null })
        if (init?.method === 'DELETE' && options.remove) return options.remove(url.split('/').at(-1)!, JSON.parse(String(init.body)).confirmationName)
        if (url.endsWith('/enabled') && init?.method === 'PATCH' && options.enabled) return options.enabled(url.split('/').at(-2)!, JSON.parse(String(init.body)).enabled)
        if (url === '/api/desktop/agents/researcher/duplicate' && init?.method === 'POST' && options.duplicate) return options.duplicate(JSON.parse(String(init.body)))
        if (url === '/api/desktop/agents' && options.refreshedAgents) return Response.json({ agents: options.refreshedAgents() })
        if (url === '/api/desktop/agents/independent/sessions') return Response.json({ sessions: [] })
        if (url === '/api/desktop/agents/researcher' && init?.method === 'PATCH') {
            if (rejectNext) {
                rejectNext = false
                return Response.json({ error: 'Could not save this name.' }, { status: 503 })
            }
            const { name } = JSON.parse(String(init.body))
            return Response.json({ agent: { ...researcher, name } })
        }
        if (url === '/api/desktop/board-activity') return Response.json({ agents: { researcher: 'idle', editor: 'idle' } })
        if (url === '/api/desktop/settings') return Response.json({ connections: [], default: null })
        if (url.endsWith('/sessions')) return Response.json({ sessions: [session] })
        if (url.endsWith('/tabs') && init?.method === 'PUT') return Response.json({ tabs: { revision: JSON.parse(String(init.body)).baseRevision + 1 } })
        if (url.endsWith('/messages')) return Response.json({ messages: [{ id: 'engine-original', role: 'assistant', parts: [{ type: 'text', text: 'Original answer.' }] }] })
        if (url.endsWith('/stop')) return Response.json({ running: false })
        if (url.includes('/feedback?')) return Response.json({ votes: [] })
        if (url.includes('/model')) return Response.json({ catalog: [], workspace: null, coworker: null, conversation: null, effective: { source: 'workspace', connectionId: null, provider: null, name: null, model: null, label: 'Select model', available: false } })
        if ((init?.method ?? 'GET') === 'GET') {
            if (/^\/api\/desktop\/agents\/[^/]+\/queue\?/.test(url)) return Response.json({ queued: null })
            if (url === '/api/desktop/pending-inbox') return Response.json({ items: [], unavailableAgentIds: [], checkedAt: '2026-11-05T00:00:00Z' })
            if (url === '/api/desktop/completions') return Response.json({ items: [], unavailableAgentIds: [], enabledAt: '2026-11-05T00:00:00Z', checkedAt: '2026-11-05T00:00:00Z', nextCursor: null })
        }
        const background = desktopBackgroundRead(url, init); if (background) return background
        throw new Error(`Unexpected request: ${init?.method ?? 'GET'} ${url}`)
    })
    vi.stubGlobal('fetch', requests)
    root = createRoot(document.body.appendChild(document.createElement('div')))
    await act(async () => {
        root.render(<DesktopLocale initial={options.language ?? englishDesktopLanguage}><DesktopApp initialData={{ profile: { id: 1, displayName: 'Local' }, workspace: { id: 1, name: 'Studio' }, agents: options.agents ?? [researcher, editor], theme: 'system', connections: [], default: null }} /></DesktopLocale>)
    })
    return {
        duplicateRequests: () => requests.mock.calls.filter(([url]) => url.endsWith('/duplicate')).map(([, init]) => JSON.parse(String(init?.body)) as DuplicateInput),
        renameRequests: () => requests.mock.calls.filter(([, init]) => init?.method === 'PATCH').map(([url, init]) => [url, JSON.parse(String(init?.body))]),
        enabledRequests: () => requests.mock.calls.filter(([url]) => url.endsWith('/enabled')).map(([url, init]) => [url, JSON.parse(String(init?.body))]),
        deleteRequests: () => requests.mock.calls.filter(([, init]) => init?.method === 'DELETE').map(([url, init]) => [url, JSON.parse(String(init?.body))]),
        chatRequests: () => requests.mock.calls.filter(([url]) => url.endsWith('/chat')),
        failNext: () => { rejectNext = true },
    }
}

const tile = (name: string) => document.querySelector<HTMLElement>(`[aria-label="Open chat with ${name}"]`)!
const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]')
const nameField = () => dialog()!.querySelector<HTMLInputElement>('input')!
const dialogButton = (label: string) => [...dialog()!.querySelectorAll('button')].find(button => button.textContent?.trim() === label)!
const click = (node: HTMLElement) => act(async () => { node.click() })
const key = (node: HTMLElement, key: string, shiftKey = false) => act(async () => {
    node.focus()
    node.dispatchEvent(new KeyboardEvent('keydown', { key, shiftKey, bubbles: true, cancelable: true }))
})
const edit = (field: HTMLInputElement | HTMLTextAreaElement, value: string) => act(async () => {
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), 'value')!.set!.call(field, value)
    field.dispatchEvent(new Event('input', { bubbles: true }))
    field.dispatchEvent(new Event('change', { bubbles: true }))
})

async function chooseAction(name: string, gesture: 'keyboard' | 'pointer', action: 'Duplicate' | 'Rename' | 'Disable' | 'Enable' | 'Delete' | 'Open chat') {
    const item = tile(name)
    if (gesture === 'keyboard') {
        await key(item, 'F10', true)
    } else {
        // happy-dom has no layout; hit the painted tile's center in the actual isometric grid.
        const layer = item.parentElement!
        const [, zoom, panX, panY] = /scale\(([^)]+)\) translate\(([-.\d]+)px,\s*([-.\d]+)px\)/.exec(layer.style.transform)!
        const x = Number(zoom) * (parseFloat(item.style.left) + parseFloat(item.style.width) / 2 + Number(panX))
        const y = Number(zoom) * (parseFloat(item.style.top) + parseFloat(item.style.height) / 2 + Number(panY))
        await act(async () => { item.dispatchEvent(new MouseEvent('contextmenu', { button: 2, clientX: x, clientY: y, bubbles: true, cancelable: true })) })
    }
    const itemAction = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(entry => entry.textContent?.trim() === action)
    expect(itemAction).toBeDefined()
    await click(itemAction!)
}

async function openRename(name: string, gesture: 'keyboard' | 'pointer') {
    await chooseAction(name, gesture, 'Rename')
    expect(dialog()?.textContent).toContain('Rename coworker')
    expect(nameField().value).toBe(name)
}

it('renames the coworker from its board menu without closing its current chat or changing its sibling', async () => {
    const api = await mount()
    const originalTile = tile('Researcher')
    await key(originalTile, 'Enter')
    const panel = document.querySelector('[aria-label="Coworker chat"]')!
    expect(panel.textContent).toContain('Original answer.')
    const composer = panel.querySelector<HTMLTextAreaElement>('textarea')!
    await edit(composer, 'Keep my draft')
    await openRename('Researcher', 'pointer')
    await edit(nameField(), '  Analyst  ')
    await click(dialogButton('Rename'))
    await vi.waitFor(() => expect(tile('Analyst')).toBe(originalTile))
    expect(dialog()).toBeNull()
    expect(api.renameRequests()).toEqual([['/api/desktop/agents/researcher', { name: 'Analyst' }]])
    expect(tile('Editor')).not.toBeNull()
    expect(panel.querySelector('h1')?.getAttribute('aria-label')).toBe('Analyst')
    expect(panel.textContent).toContain('Original conversation')
    expect(panel.textContent).toContain('Original answer.')
    expect(panel.querySelector('textarea')).toBe(composer)
    expect(composer.value).toBe('Keep my draft')
})

it('opens from the keyboard, cancels unchanged edits and lets the user retry a failed rename', async () => {
    const api = await mount()
    await openRename('Researcher', 'keyboard')
    await edit(nameField(), '   ')
    expect(dialogButton('Rename').disabled).toBe(true)
    await edit(nameField(), 'Discard me')
    await click(dialogButton('Cancel'))
    expect(dialog()).toBeNull()
    expect(api.renameRequests()).toHaveLength(0)
    await openRename('Researcher', 'keyboard')
    await click(dialogButton('Rename'))
    expect(dialog()).toBeNull()
    expect(api.renameRequests()).toHaveLength(0)
    await openRename('Researcher', 'keyboard')
    await edit(nameField(), 'Analyst')
    api.failNext()
    await click(dialogButton('Rename'))
    await vi.waitFor(() => expect(dialog()?.textContent).toContain('Could not save this name.'))
    expect(nameField().value).toBe('Analyst')
    expect(tile('Researcher')).not.toBeNull()
    await click(dialogButton('Rename'))
    await vi.waitFor(() => expect(tile('Analyst')).not.toBeNull())
    expect(api.renameRequests()).toHaveLength(2)
    expect(tile('Editor')).not.toBeNull()
    expect(document.querySelector('[aria-label="Coworker chat"]')).toBeNull()
})

const boardButton = (label: string) => [...document.querySelectorAll<HTMLButtonElement>('[aria-label="Board actions"] button')].find(button => button.textContent === label)!

it('can cancel a pointer-started copy and retry a keyboard placement without duplicating twice or inheriting a chat', async () => {
    let interrupt = true
    const api = await mount({ duplicate: ({ position }) => {
        if (interrupt) {
            interrupt = false
            return Response.json({ error: 'Could not confirm this copy.' }, { status: 502 })
        }
        return Response.json({ agent: { ...copy, position } })
    } })
    await key(tile(researcher.name), 'Enter')
    expect(document.querySelector('[aria-label="Coworker chat"]')?.textContent).toContain('Original answer.')
    await chooseAction(researcher.name, 'pointer', 'Duplicate')
    expect(document.body.textContent).toContain('Tap a tile to place Researcher copy')
    await click(boardButton('Cancel'))
    expect(api.duplicateRequests()).toEqual([])
    expect(tile(copy.name)).toBeNull()

    await chooseAction(researcher.name, 'keyboard', 'Duplicate')
    await click(boardButton('Place copy'))
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('Could not confirm this copy.')
    await click(boardButton('Retry'))
    const [first, retry] = api.duplicateRequests()
    expect(first.requestId).toMatch(/^[0-9a-f-]{36}$/)
    expect(retry).toEqual(first)
    await vi.waitFor(() => expect(document.querySelector('[aria-label="Coworker chat"] h1')?.getAttribute('aria-label')).toBe(copy.name))
    expect(document.querySelector('[aria-label="Coworker chat"]')?.textContent).not.toContain('Original answer.')
    expect(document.querySelectorAll(`[data-tile-id="${copy.id}"]`)).toHaveLength(1)
    expect(tile(researcher.name)).not.toBeNull()
    expect(tile(editor.name)).not.toBeNull()
})

it('refreshes an occupied placement before offering another slot', async () => {
    let occupied: GridPosition | undefined
    const neighbor = { ...editor, id: 'neighbor', name: 'New coworker' }
    const api = await mount({
        duplicate: ({ position }) => {
            if (!occupied) {
                occupied = position
                return Response.json({ code: 'position_occupied' }, { status: 409 })
            }
            return Response.json({ agent: { ...copy, position } })
        },
        refreshedAgents: () => [researcher, editor, { ...neighbor, position: occupied }],
    })
    await chooseAction(researcher.name, 'keyboard', 'Duplicate')
    await click(boardButton('Place copy'))
    expect(tile(neighbor.name)).not.toBeNull()
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('Choose another.')
    await click(boardButton('Place copy'))
    const [first, second] = api.duplicateRequests()
    expect(second.position).not.toEqual(first.position)
    expect(second.requestId).toBe(first.requestId)
    expect(tile(copy.name)).not.toBeNull()
})

it('disables and enables from the board while preserving the selected chat, draft and board position', async () => {
    const api = await mount({ enabled: (id, enabled) => Response.json({ agent: { ...(id === researcher.id ? researcher : editor), enabled, updatedAt: new Date().toISOString() } }) })
    const originalTile = tile(researcher.name)
    const originalPosition = [originalTile.style.left, originalTile.style.top]
    await key(originalTile, 'Enter')
    const panel = document.querySelector<HTMLElement>('[aria-label="Coworker chat"]')!
    const composer = panel.querySelector<HTMLTextAreaElement>('textarea')!
    await edit(composer, 'Keep my follow-up')
    expect(panel.querySelector('[aria-description="Opens a new chat and keeps the original"]')).not.toBeNull()
    await chooseAction(researcher.name, 'pointer', 'Disable')
    await vi.waitFor(() => expect(composer.disabled).toBe(true))
    expect(tile(researcher.name)).toBe(originalTile)
    expect([originalTile.style.left, originalTile.style.top]).toEqual(originalPosition)
    expect(panel.querySelector('textarea')).toBe(composer)
    expect(composer.value).toBe('Keep my follow-up')
    expect(panel.textContent).toContain('Original answer.')
    expect(panel.textContent).toContain('Original conversation')
    expect(panel.textContent).toContain('This coworker is inactive.')
    expect(panel.querySelector('[aria-description="Opens a new chat and keeps the original"]')).toBeNull()
    expect(document.querySelector('[data-board-activity="Researcher"]')?.getAttribute('data-status')).toBe('inactive')
    expect(document.querySelector('[data-board-activity="Editor"]')?.getAttribute('data-status')).toBe('idle')
    // Even a submitted form must not begin a request while disabled.
    await act(async () => { composer.form!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) })
    expect(api.chatRequests()).toHaveLength(0)
    await chooseAction(researcher.name, 'keyboard', 'Enable')
    await vi.waitFor(() => expect(composer.disabled).toBe(false))
    expect(panel.textContent).not.toContain('This coworker is inactive.')
    expect(composer.value).toBe('Keep my follow-up')
    expect(panel.textContent).toContain('Original answer.')
    expect(panel.querySelector('[aria-description="Opens a new chat and keeps the original"]')).not.toBeNull()
    expect(api.enabledRequests()).toEqual([
        ['/api/desktop/agents/researcher/enabled', { enabled: false }],
        ['/api/desktop/agents/researcher/enabled', { enabled: true }],
    ])
})

it('opens a saved inactive coworker and retries its failed enable without losing history', async () => {
    let fail = true
    const api = await mount({ agents: [{ ...researcher, enabled: false }, editor], enabled: (id, enabled) => {
        if (fail) { fail = false; return Response.json({ error: 'Could not confirm the change. Try again.' }, { status: 502 }) }
        return Response.json({ agent: { ...researcher, enabled, updatedAt: '2026-11-03' } })
    } })
    await chooseAction(researcher.name, 'keyboard', 'Open chat')
    const panel = document.querySelector<HTMLElement>('[aria-label="Coworker chat"]')!
    expect(panel.querySelector('textarea')!.disabled).toBe(true)
    expect(panel.textContent).toContain('Original answer.')
    await chooseAction(researcher.name, 'keyboard', 'Enable')
    const alert = document.querySelector<HTMLElement>('[role="alert"]')!
    expect(alert.textContent).toContain('Could not confirm the change.')
    expect(panel.querySelector('textarea')!.disabled).toBe(true)
    expect(panel.textContent).toContain('Original answer.')
    await click([...alert.querySelectorAll('button')].find(button => button.textContent === 'Retry')!)
    await vi.waitFor(() => expect(panel.querySelector('textarea')!.disabled).toBe(false))
    expect(api.enabledRequests()).toHaveLength(2)
    expect(panel.textContent).toContain('Original conversation')
    expect(panel.textContent).toContain('Original answer.')
})

const deleteDialog = () => document.querySelector<HTMLElement>('[role="alertdialog"]')
const confirmation = () => deleteDialog()!.querySelector<HTMLInputElement>('input')!
const deleteButton = (label: string) => [...deleteDialog()!.querySelectorAll('button')].find(button => button.textContent?.trim() === label)!

it('requires the coworker name, cancels safely, and deletes only the copy while the original chat stays open', async () => {
    const api = await mount({ agents: [researcher, editor, { ...copy, position: { col: 1, row: 1 } }],
        remove: id => Response.json({ deletedAgentId: id }),
    })
    await key(tile(researcher.name), 'Enter')
    const panel = document.querySelector<HTMLElement>('[aria-label="Coworker chat"]')!
    const composer = panel.querySelector<HTMLTextAreaElement>('textarea')!
    const originalTile = tile(researcher.name)
    const originalPosition = [originalTile.style.left, originalTile.style.top]
    await edit(composer, 'Keep the original draft')
    await chooseAction(copy.name, 'pointer', 'Delete')
    expect(deleteDialog()?.textContent).toContain('Delete this coworker?')
    expect(deleteDialog()?.textContent).toContain('This action cannot be undone.')
    expect(deleteButton('Delete').disabled).toBe(true)
    await edit(confirmation(), researcher.name)
    await key(confirmation(), 'Enter')
    expect(api.deleteRequests()).toEqual([])
    await edit(confirmation(), copy.name)
    await click(deleteButton('Cancel'))
    expect(deleteDialog()).toBeNull()
    expect(api.deleteRequests()).toEqual([])
    expect(tile(copy.name)).not.toBeNull()

    await chooseAction(copy.name, 'keyboard', 'Delete')
    expect(confirmation().value).toBe('')
    await edit(confirmation(), `  ${copy.name}  `)
    await click(deleteButton('Delete'))
    await vi.waitFor(() => expect(tile(copy.name)).toBeNull())
    expect(deleteDialog()).toBeNull()
    expect(api.deleteRequests()).toEqual([['/api/desktop/agents/independent', { confirmationName: copy.name }]])
    expect(tile(researcher.name)).toBe(originalTile)
    expect([originalTile.style.left, originalTile.style.top]).toEqual(originalPosition)
    expect(tile(editor.name)).not.toBeNull()
    expect(document.querySelector('[aria-label="Coworker chat"]')).toBe(panel)
    expect(panel.querySelector('textarea')).toBe(composer)
    expect(composer.value).toBe('Keep the original draft')
    expect(panel.textContent).toContain('Original answer.')
    expect(panel.textContent).toContain('Original conversation')
})

it('waits for deletion, retains a failed confirmation for retry, and closes only the deleted coworker panel', async () => {
    let finish: (response: Response) => void = () => {}
    const api = await mount({ remove: () => new Promise<Response>(resolve => { finish = resolve }) })
    await key(tile(researcher.name), 'Enter')
    await chooseAction(researcher.name, 'keyboard', 'Delete')
    await edit(confirmation(), researcher.name)
    await click(deleteButton('Delete'))
    expect(deleteButton('Deleting…').disabled).toBe(true)
    expect(deleteButton('Cancel').disabled).toBe(true)
    expect(confirmation().disabled).toBe(true)
    await key(confirmation(), 'Enter')
    expect(api.deleteRequests()).toHaveLength(1)
    expect(tile(researcher.name)).not.toBeNull()
    expect(document.querySelector('[aria-label="Coworker chat"]')?.textContent).toContain('Original answer.')
    await act(async () => finish(Response.json({ error: 'Stop the current reply before deleting this coworker.' }, { status: 409 })))
    expect(deleteDialog()?.textContent).toContain('Stop the current reply')
    expect(confirmation().value).toBe(researcher.name)
    expect(deleteButton('Delete').disabled).toBe(false)
    await click(deleteButton('Delete'))
    await act(async () => finish(Response.json({ deletedAgentId: researcher.id })))
    expect(api.deleteRequests()).toHaveLength(2)
    expect(deleteDialog()).toBeNull()
    expect(tile(researcher.name)).toBeNull()
    expect(tile(editor.name)).not.toBeNull()
    expect(document.querySelector('[aria-label="Coworker chat"]')).toBeNull()
})

it('ignores a late enabled response after that coworker has been deleted', async () => {
    let enabledReply: (response: Response) => void = () => {}
    const api = await mount({
        enabled: () => new Promise<Response>(resolve => { enabledReply = resolve }),
        remove: id => Response.json({ deletedAgentId: id }),
    })
    await chooseAction(researcher.name, 'keyboard', 'Disable')
    await chooseAction(researcher.name, 'keyboard', 'Delete')
    await edit(confirmation(), researcher.name)
    await click(deleteButton('Delete'))
    expect(tile(researcher.name)).toBeNull()
    await act(async () => enabledReply(Response.json({ agent: { ...researcher, enabled: false, updatedAt: 'future' } })))
    expect(api.deleteRequests()).toHaveLength(1)
    expect(tile(researcher.name)).toBeNull()
    expect(tile(editor.name)).not.toBeNull()
    expect(document.querySelector('[aria-label="Coworker chat"]')).toBeNull()
})

it('French deletion still requires the exact coworker name and Cancel keeps the saved chat', async () => {
    const agent = { ...researcher, name: 'Élodie · QA' }
    const api = await mount({ agents: [agent, editor], remove: id => Response.json({ deletedAgentId: id }),
        language: { locale: 'fr', preference: 'fr', messages: desktopMessages('fr', await loadMessages('fr')) } })
    const item = document.querySelector<HTMLElement>('[aria-label="Ouvrir la conversation avec Élodie · QA"]')!
    await key(item, 'ContextMenu')
    const remove = [...document.querySelectorAll('[role="menuitem"]')].find(node => node.textContent?.trim() === 'Supprimer')!
    await click(remove as HTMLElement)
    expect(deleteDialog()?.textContent).toContain('Supprimer ce coworker')
    expect(deleteButton('Supprimer').disabled).toBe(true)
    await edit(confirmation(), 'Elodie · QA')
    await key(confirmation(), 'Enter')
    expect(api.deleteRequests()).toEqual([])
    await edit(confirmation(), agent.name)
    expect(deleteButton('Supprimer').disabled).toBe(false)
    await click(deleteButton('Annuler'))
    expect(deleteDialog()).toBeNull()
    expect(api.deleteRequests()).toEqual([])
    expect(item.isConnected).toBe(true)
})

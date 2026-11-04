// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { DesktopApp, type DesktopAgentView } from './DesktopApp'
import type { GridPosition } from '@rerun/ui/iso-grid'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const researcher = { id: 'researcher', name: 'Researcher', description: '', createdAt: '', updatedAt: '' }
const editor = { ...researcher, id: 'editor', name: 'Editor' }
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
} = {}) {
    let rejectNext = false
    const requests = vi.fn(async (url: string, init?: RequestInit) => {
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
        throw new Error(`Unexpected request: ${init?.method ?? 'GET'} ${url}`)
    })
    vi.stubGlobal('fetch', requests)
    root = createRoot(document.body.appendChild(document.createElement('div')))
    await act(async () => {
        root.render(<DesktopApp initialData={{ profile: { id: 1, displayName: 'Local' }, workspace: { id: 1, name: 'Studio' }, agents: [researcher, editor], theme: 'system', connections: [], default: null }} />)
    })
    return {
        duplicateRequests: () => requests.mock.calls.filter(([url]) => url.endsWith('/duplicate')).map(([, init]) => JSON.parse(String(init?.body)) as DuplicateInput),
        renameRequests: () => requests.mock.calls.filter(([, init]) => init?.method === 'PATCH').map(([url, init]) => [url, JSON.parse(String(init?.body))]),
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

async function chooseAction(name: string, gesture: 'keyboard' | 'pointer', action: 'Duplicate' | 'Rename') {
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

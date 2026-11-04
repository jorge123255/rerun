// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import type { DesktopAgentView } from './DesktopApp'
import { DesktopCoworkerTools } from './DesktopCoworkerTools'
import type { CoworkerToolPatch, CoworkerToolRow } from '@/lib/desktop/coworker-tools'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

afterEach(() => { vi.unstubAllGlobals(); document.body.innerHTML = '' })

it('grants only the selected coworker, rolls back a failed revoke, and reloads the saved switch', async () => {
    const permissions = new Map<string, boolean>()
    let failWrite = false
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
        if (init.method === 'PATCH') {
            if (failWrite) return Response.json({ error: 'Try again.' }, { status: 503 })
            const { group, id, enabled } = JSON.parse(String(init.body))
            permissions.set(url + '/' + group + '/' + id, enabled)
        }
        const row = (group: string, id: string, available = true): CoworkerToolRow => ({
            id, label: group === 'rerun' ? 'Read workspace files' : 'Run commands', description: 'This coworker', tools: ['fs_read'],
            enabled: permissions.get(url + '/' + group + '/' + id) ?? false, available,
            ...(!available && { unavailableReason: 'Workspace shell unavailable.' }),
        })
        return Response.json({ rerun: [row('rerun', 'workspaceRead')], codex: [row('codex', 'shell', false)] })
    })
    const root = createRoot(document.body.appendChild(document.createElement('div')))
    const render = (id: string) => act(async () => root.render(<DesktopCoworkerTools key={id} agent={{ id, name: id } as DesktopAgentView} />))
    const button = (name: string) => Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find(b => b.textContent === name)!
    const click = (el: HTMLElement) => act(async () => el.click())
    const toggle = () => document.querySelector<HTMLButtonElement>('[role="switch"]')!
    try {
        await render('first'); await click(button('Tools'))
        expect(toggle().getAttribute('aria-checked')).toBe('false')
        await click(toggle())
        expect(toggle().getAttribute('aria-checked')).toBe('true')
        failWrite = true; await click(toggle())
        expect(toggle().getAttribute('aria-checked')).toBe('true')
        expect(document.querySelector('[role="alert"]')?.textContent).toContain('Try again.')
        await click(button('Done')); await render('second'); await click(button('Tools'))
        expect(toggle().getAttribute('aria-checked')).toBe('false')
        await click(button('Done')); await render('first'); await click(button('Tools'))
        expect(toggle().getAttribute('aria-checked')).toBe('true')
        expect(Array.from(permissions.keys())).toEqual(['/api/desktop/agents/first/tools/rerun/workspaceRead'])
        const unavailable = button('Unavailable tools (1)')
        expect(unavailable.getAttribute('aria-expanded')).toBe('false')
        expect(document.querySelectorAll('[role="switch"]')).toHaveLength(1)
        unavailable.focus()
        await click(unavailable)
        expect(unavailable.getAttribute('aria-expanded')).toBe('true')
        expect(document.querySelectorAll<HTMLButtonElement>('[role="switch"]')[1].disabled).toBe(true)
        expect(document.body.textContent).toContain('Workspace shell unavailable.')
        await click(unavailable)
        expect(unavailable.getAttribute('aria-expanded')).toBe('false')
        expect(document.activeElement).toBe(unavailable)
    } finally { await act(async () => root.unmount()) }
})

it('shows the Improve itself master with its nested own-instruction and reply-length permissions', async () => {
    const labels: Record<string, string> = { self: 'Improve itself', selfInstruction: 'Edit own instructions', verbositySet: 'Change reply length' }
    const row = (id: string, enabled: boolean, parent?: string, available = true): CoworkerToolRow => ({
        id, label: labels[id] ?? id, description: '', tools: [], available, enabled, parent,
        ...(!available && { unavailableReason: 'Turn on Improve itself to change this permission.' }),
    })
    let master = true, own = false, length = false
    const patches: CoworkerToolPatch[] = []
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
        if (init.method === 'PATCH') {
            const patch = JSON.parse(String(init.body))
            patches.push(patch)
            if (patch.id === 'self') master = patch.enabled
            if (patch.id === 'selfInstruction') own = patch.enabled
            if (patch.id === 'verbositySet') length = patch.enabled
        }
        const nested = master
            ? [row('selfInstruction', own, 'self'), row('verbositySet', length, 'self')]
            : [row('selfInstruction', false, 'self', false), row('verbositySet', false, 'self', false)]
        return Response.json({ rerun: [row('self', master), ...nested], codex: [] })
    })
    const root = createRoot(document.body.appendChild(document.createElement('div')))
    try {
        await act(async () => root.render(<DesktopCoworkerTools agent={{ id: 'first', name: 'First' } as DesktopAgentView} />))
        await act(async () => Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find(b => b.textContent === 'Tools')!.click())
        const switches = () => Array.from(document.querySelectorAll<HTMLButtonElement>('[role="switch"]'))
        expect(switches()).toHaveLength(3)
        expect(switches()[0].getAttribute('aria-checked')).toBe('true')
        expect(document.body.textContent).toContain('Edit own instructions')
        expect(document.body.textContent).toContain('Change reply length')
        await act(async () => switches()[1].click())
        expect(patches).toEqual([{ group: 'rerun', id: 'selfInstruction', enabled: true }])
        await act(async () => switches()[0].click())
        expect(patches.at(-1)).toEqual({ group: 'rerun', id: 'self', enabled: false })
        expect(document.querySelectorAll('[role="switch"]')).toHaveLength(1)
        const disclosure = Array.from(document.querySelectorAll('button')).find(el => el.textContent === 'Unavailable tools (2)')!
        await act(async () => disclosure.click())
        expect(document.body.textContent).toContain('Turn on Improve itself to change this permission.')
    } finally { await act(async () => root.unmount()) }
})

it('puts usable tools from both providers before the single disclosure and keeps a paused grant revocable', async () => {
    const row = (id: string, available: boolean, enabled = false): CoworkerToolRow => ({
        id, label: id, description: '', tools: [], available, enabled, ...(!available && { unavailableReason: 'Requires setup.' }),
    })
    const tools = { rerun: [row('shared', false), row('read', true), row('paused', false, true)], codex: [row('native-web', true), row('connectors', false)] }
    vi.stubGlobal('fetch', async () => Response.json(tools))
    const root = createRoot(document.body.appendChild(document.createElement('div')))
    try {
        await act(async () => root.render(<DesktopCoworkerTools agent={{ id: 'owner', name: 'Owner' } as DesktopAgentView} />))
        await act(async () => document.querySelector<HTMLButtonElement>('button')!.click())
        const labels = () => Array.from(document.querySelectorAll('label'), el => el.textContent)
        expect(labels()).toEqual(['read', 'paused', 'native-web'])
        expect(document.querySelectorAll<HTMLButtonElement>('[role="switch"]')[1].disabled).toBe(false)
        const disclosure = Array.from(document.querySelectorAll('button')).find(el => el.textContent === 'Unavailable tools (2)')!
        expect(disclosure.type).toBe('button')
        expect(disclosure.tabIndex).toBe(0)
        await act(async () => disclosure.click())
        expect(labels()).toEqual(['read', 'paused', 'native-web', 'shared', 'connectors'])
    } finally { await act(async () => root.unmount()) }
})

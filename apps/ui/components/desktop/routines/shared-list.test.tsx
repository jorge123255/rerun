// @vitest-environment happy-dom
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { DesktopWorkspaceRoutine } from '@rerun/contracts'

vi.mock('@/lib/desktop/use-schedule-tool-notices', () => ({ useDesktopScheduleToolNotices: () => null }))
vi.mock('@/components/ui/panel-steps', () => ({ PanelSteps: ({ children }: { children: ReactNode }) => <>{children}</> }))
// Rows animate in; happy-dom rejects an animation cancelled by the next render.
vi.mock('motion/react', async original => {
    const actual = await original<typeof import('motion/react')>()
    const { createElement, forwardRef } = await import('react')
    const plain = (tag: string) => forwardRef<HTMLElement, Record<string, unknown>>(({ children, ...props }, ref) =>
        createElement(tag, { ...Object.fromEntries(Object.entries(props).filter(([name]) => !actual.isValidMotionProp(name))), ref }, children as ReactNode))
    const elements = new Map<string, ReturnType<typeof plain>>()
    const element = (tag: string) => { if (!elements.has(tag)) elements.set(tag, plain(tag)); return elements.get(tag)! }
    return { ...actual, AnimatePresence: ({ children }: { children: ReactNode }) => <>{children}</>, motion: new Proxy(actual.motion, { get(target, key, receiver) {
        if (key === 'create') return (tag: unknown) => typeof tag === 'string' ? element(tag) : tag
        return typeof key === 'string' && key !== 'then' ? element(key) : Reflect.get(target, key, receiver)
    } }) }
})
import { DesktopWorkspaceRoutines } from '../foreman/routines/DesktopWorkspaceRoutines'
import { DesktopCoworkerSchedules } from '../schedules/DesktopCoworkerSchedules'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const revision = 'a'.repeat(64)
// The coworker's buddy, as the shared list draws it.
const FACE = '[data-buddy-still], [data-buddy-motion]'
const chat = { agentId: 'alice', sessionId: 'chat-a', engineSessionId: 'engine-chat-a', tabUid: 'schedule:chat-a', title: 'Daily result', runId: 'run-a' }
// One saved routine, as each screen reads it: the workspace's list for the Chief of Staff, the coworker's own tasks.
const saved = { slug: 'daily', name: 'Daily digest', description: '', body: 'Report.', cron: '0 8 * * *', runAt: null, timezone: 'UTC', enabled: true, revision, nextRunAt: null, setupPending: false,
    lastResult: { status: 'done', runId: 'run-a', chat } }
const routine: DesktopWorkspaceRoutine = { ...saved, agentId: 'alice', frequency: 'Every day at 8:00 AM', runningSince: null, lastRunAt: '2026-11-05T08:00:00.000Z' }
const mutations: Array<Record<string, unknown>> = []
const roots: Root[] = []
beforeEach(() => {
    mutations.length = 0
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
        if (url === '/api/desktop/workspace/routines' && init?.method === 'POST') {
            const body = JSON.parse(String(init.body)); mutations.push(body)
            return Response.json({ routine: { ...routine, ...(body.action === 'rename' && { name: body.name }) }, ...(body.action === 'run' && { chat }) })
        }
        if (url === '/api/desktop/workspace/routines') return Response.json({ routines: [routine], canRename: true })
        if (url.startsWith('/api/desktop/coworkers/alice/schedules')) return Response.json([{ ...saved, connectionId: null, provider: null, model: null }])
        throw new Error(`Unexpected request ${url}`)
    }))
})
afterEach(async () => { await act(async () => { for (const root of roots.splice(0)) root.unmount() }); document.body.innerHTML = ''; vi.unstubAllGlobals() })
async function mount(node: ReactNode) {
    const host = document.body.appendChild(document.createElement('div'))
    const root = createRoot(host); roots.push(root)
    await act(async () => root.render(node))
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 5)) })
    return host
}
const rowOf = (host: HTMLElement) => [...host.querySelectorAll<HTMLElement>('[role="button"]')].find(node => node.textContent?.includes('Daily digest'))!
async function menuOf(host: HTMLElement) {
    const more = rowOf(host).querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]')!
    more.focus()
    await act(async () => { more.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })) })
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 5)) })
    return [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
}

test('a coworker\'s routines and the Chief of Staff\'s are one list: the same rows, switch and menu, acting through the same change', async () => {
    const { createDesktopWorkspaceRoutinesClient } = await import('@/lib/desktop/workspace-routines/client')
    const onOpenChat = vi.fn(), onOpenSession = vi.fn()
    const chief = await mount(<DesktopWorkspaceRoutines client={createDesktopWorkspaceRoutinesClient()} agentNameOf={() => 'Alice'} onOpenChat={onOpenChat} docked={false} />)
    const coworker = await mount(<DesktopCoworkerSchedules agentId="alice" onOpenSession={onOpenSession} />)
    for (const host of [chief, coworker]) {
        // The same group heading, the same rule, the same switch.
        expect(rowOf(host).closest('section')!.querySelector('h3')).not.toBeNull()
        expect(rowOf(host).textContent).toContain('Every day at 8:00 AM')
        expect(rowOf(host).querySelector('[role="switch"]')!.getAttribute('aria-label')).toBe('Pause Daily digest')
    }
    expect(rowOf(chief).closest('section')!.querySelector('h3')!.textContent).toBe(rowOf(coworker).closest('section')!.querySelector('h3')!.textContent)
    // The workspace's list says whose routine each is; a coworker's own drops the face and the name, and keeps the last run.
    expect(rowOf(chief).querySelector(FACE)).not.toBeNull()
    expect(rowOf(chief).textContent).toContain('Alice')
    expect(rowOf(coworker).querySelector(FACE)).toBeNull()
    expect(rowOf(coworker).textContent).not.toContain('Alice')
    expect(rowOf(coworker).querySelector('[data-routine-footer]')!.textContent).toBe('Last result: Done')
    expect(rowOf(chief).querySelector('[data-routine-footer]')).toBeNull()

    const labels: string[][] = []
    for (const host of [chief, coworker]) {
        const items = await menuOf(host)
        labels.push(items.map(item => item.textContent ?? ''))
        // Run now from either list is the same change, and opens the run's chat.
        await act(async () => { items.at(-1)!.click() })
        await act(async () => { await new Promise(resolve => setTimeout(resolve, 5)) })
    }
    expect(labels[0]).toEqual(['Rename', 'Edit', 'Open result chat', 'Run now'])
    expect(labels[1]).toEqual(labels[0])
    expect(mutations).toEqual([0, 1].map(() => ({ action: 'run', agentId: 'alice', slug: 'daily', expectedRevision: revision, requestId: expect.any(String) })))
    expect(onOpenChat).toHaveBeenCalledExactlyOnceWith(chat)
    expect(onOpenSession).toHaveBeenCalledExactlyOnceWith(chat)

    // Rename from the coworker's own list: the field replaces the name in place, as in the Chief of Staff's.
    await act(async () => { (await menuOf(coworker))[0]!.click() })
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 5)) })
    const field = rowOf(coworker)?.querySelector('input') ?? coworker.querySelector<HTMLInputElement>('[role="button"] input')
    expect(field).not.toBeNull()
})

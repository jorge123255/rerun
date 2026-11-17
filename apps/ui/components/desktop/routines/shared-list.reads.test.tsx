// @vitest-environment happy-dom
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { DesktopWorkspaceRoutine } from '@rerun/contracts'

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
const rowOf = (host: HTMLElement) => [...host.querySelectorAll<HTMLElement>('[role="button"]')].find(node => node.textContent?.includes('Daily digest'))!
test('the Chief of Staff\'s list reads nothing while it is out of sight, reads once when it shows, and keeps its rows when a later read fails', async () => {
    const { createDesktopWorkspaceRoutinesClient } = await import('@/lib/desktop/workspace-routines/client')
    const client = createDesktopWorkspaceRoutinesClient()
    const reads = () => vi.mocked(fetch).mock.calls.filter(([url, init]) => url === '/api/desktop/workspace/routines' && !init?.method).length
    const host = document.body.appendChild(document.createElement('div'))
    const root = createRoot(host); roots.push(root)
    const render = async (active: boolean) => {
        await act(async () => { root.render(<DesktopWorkspaceRoutines client={client} agentNameOf={() => 'Alice'} onOpenChat={vi.fn()} docked={false} active={active} />) })
        await act(async () => { await new Promise(resolve => setTimeout(resolve, 5)) })
    }
    await render(false)
    expect(reads()).toBe(0)
    await render(true)
    expect(reads()).toBe(1)
    expect(rowOf(host)).toBeDefined()
    // Hidden again, then shown: one more read, and an engine that cannot be reached leaves the rows on screen.
    await render(false)
    vi.mocked(fetch).mockImplementation(async () => Response.json({ error: 'The engine is not running.' }, { status: 503 }))
    await render(true)
    expect(reads()).toBe(2)
    expect(rowOf(host)).toBeDefined()
    expect(host.textContent).not.toContain('No routines yet')
})

// @vitest-environment happy-dom
import { randomUUID } from 'node:crypto'
import { StrictMode, act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { DesktopForemanPanel } from './DesktopForemanPanel'
import type { DesktopForemanColumnProps } from './DesktopForemanColumn'
import { cancelDraftShutdown, flushDesktopDrafts, isDesktopQuitting } from '@/lib/desktop/draft-writes'
import { DEFAULT_DESKTOP_FOREMAN_PLACEMENT, flushDesktopForemanUiSaves, saveForemanUiIfMatching } from '@/lib/desktop/foreman-client'
let column: DesktopForemanColumnProps
vi.mock('./DesktopForemanColumn', () => ({ DesktopForemanColumn: (props: DesktopForemanColumnProps) => {
    column = props
    return <><button onClick={props.onClose}>Close Foreman</button>{props.runNotice}</>
} }))
let root: Root | undefined
const sources: Source[] = []
class Source {
    closed = false
    onmessage: ((event: { data: string }) => void) | null = null
    constructor(readonly url: string) { sources.push(this) }
    close() { this.closed = true }
}
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = undefined; await flushDesktopForemanUiSaves(); document.body.innerHTML = ''; vi.unstubAllGlobals(); vi.useRealTimers(); cancelDraftShutdown(); sources.length = 0 })
it('keeps a usable exact-chat adapter through StrictMode and closes every live subscription on unmount', async () => {
    cancelDraftShutdown(); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); vi.stubGlobal('crypto', { randomUUID }); vi.stubGlobal('EventSource', Source)
    const chat = { workspaceId: '1', chatId: 'fmc_abcdefgh' }
    const server = { chat, sessionId: 'session', model: null, messages: [{ id: 'message', role: 'user', parts: [{ type: 'text', text: 'A saved message' }] }], view: { contractVersion: 1, chat, phase: 'plan', live: null, revisions: [], currentRevisionId: null, decisions: [], build: null, discovery: null, blocked: null }, ui: { revision: 0, snapshot: null as unknown } }
    const sends: unknown[] = []
    vi.stubGlobal('fetch', vi.fn(async (_url, init?: RequestInit) => {
        if (!init?.body) return Response.json(server)
        const body = JSON.parse(String(init.body))
        if (body.action === 'ui') { server.ui = { revision: server.ui.revision + 1, snapshot: body.snapshot }; return Response.json({ revision: server.ui.revision }) }
        if (body.action === 'send') { sends.push(body); return Response.json({ runId: body.requestId }) }
        return Response.json({ ok: true })
    }))
    const onClose = vi.fn(), onOpenCoworker = vi.fn(), onOpenBox = vi.fn()
    root = createRoot(document.body.appendChild(document.createElement('div')))
    await act(async () => root!.render(<StrictMode><DesktopForemanPanel onClose={onClose} onOpenCoworker={onOpenCoworker} onOpenCalledChat={onOpenCoworker} onOpenBox={onOpenBox} agentNameOf={id => id} /></StrictMode>))
    expect(column.messages).toEqual([{ id: 'message', role: 'user', text: 'A saved message', docs: [], history: [{ key: '["message",0,null]', kind: 'text', text: 'A saved message' }] }])
    await act(async () => { expect(await column.ports.conversation.sendMessage('hello')).toBe(true) })
    expect(sends).toHaveLength(1); expect(onOpenCoworker).not.toHaveBeenCalled(); expect(onOpenBox).not.toHaveBeenCalled()
    await act(async () => document.querySelector<HTMLButtonElement>('button')!.click())
    expect(onClose).toHaveBeenCalledTimes(1)
    await act(async () => root!.unmount()); root = undefined
    expect(sources.length).toBeGreaterThan(0); expect(sources.every(source => source.closed)).toBe(true)
})

it('pauses parked Foreman SSE and polling before Quit, drains its admitted draft save, and resumes one feed after cancelled Quit without replay', async () => {
    cancelDraftShutdown(); vi.useFakeTimers(); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); vi.stubGlobal('crypto', { randomUUID }); vi.stubGlobal('EventSource', Source)
    const chat = { workspaceId: '1', chatId: 'fmc_quitpause' }, model = { connectionId: 'connection', model: 'model' }, runId = '00000000-0000-4000-8000-000000000001'
    const server = { chat, sessionId: 'session', model: null, messages: [], view: { contractVersion: 1, chat, phase: 'plan', live: { runId, model }, revisions: [], currentRevisionId: null, decisions: [], build: null, discovery: null, blocked: null }, ui: { revision: 0, snapshot: null as unknown } }
    let reads = 0, release!: () => void, entered!: () => void
    const gate = new Promise<void>(resolve => { release = resolve }), writing = new Promise<void>(resolve => { entered = resolve })
    const actions: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (_url, init?: RequestInit) => {
        if (!init?.body) { reads++; return Response.json(server) }
        const body = JSON.parse(String(init.body)); actions.push(body.action)
        if (body.action === 'ui') { entered(); await gate; server.ui = { revision: server.ui.revision + 1, snapshot: body.snapshot }; return Response.json({ revision: server.ui.revision }) }
        return Response.json({ ok: true })
    }))
    const onClose = vi.fn(), onOpenBox = vi.fn(), onOpenCoworker = vi.fn()
    root = createRoot(document.body.appendChild(document.createElement('div')))
    await act(async () => root!.render(<DesktopForemanPanel hidden controlledOpen={false} onClose={onClose} onOpenBox={onOpenBox} onOpenCoworker={onOpenCoworker} onOpenCalledChat={onOpenCoworker} agentNameOf={id => id} />))
    expect(sources.filter(source => !source.closed)).toHaveLength(1)
    const original = sources.find(source => !source.closed)!, oldCallback = original.onmessage!
    const navigation = (eventId: string) => ({ data: JSON.stringify({ type: 'navigation', binding: { ...chat, runId, model }, eventId, intent: { kind: 'open_box', spaceId: 'saved-box' } }) })
    await act(async () => oldCallback(navigation('already-seen')))
    expect(onOpenBox).toHaveBeenCalledOnce()
    // Closing/parking a column normally keeps its live feed. Only shutdown pauses it.
    await act(async () => column.onClose?.())
    expect(onClose).toHaveBeenCalledOnce(); expect(original.closed).toBe(false)

    const snapshot = { ...chat, open: false, tab: 'assistant' as const, draft: 'Keep this draft through the first Quit', pendingPlanRevisionId: null, decision: { status: 'idle' as const }, build: null, discoveries: null, placement: DEFAULT_DESKTOP_FOREMAN_PLACEMENT }
    const saving = saveForemanUiIfMatching(column.ports.persistence, snapshot)
    await writing
    const drafts = flushDesktopDrafts(), uiSaves = flushDesktopForemanUiSaves()
    let uiDrained = false; void uiSaves.then(() => { uiDrained = true })
    expect(isDesktopQuitting()).toBe(true); expect(original.closed).toBe(true); expect(original.onmessage).toBeNull()
    const pausedReads = reads
    await act(async () => { oldCallback(navigation('during-quit')); vi.advanceTimersByTime(6000); await Promise.resolve() })
    expect(reads).toBe(pausedReads); expect(uiDrained).toBe(false); expect(onOpenBox).toHaveBeenCalledOnce()
    await act(async () => { release(); await saving; expect(await uiSaves).toBe(true); expect(await drafts).toBe(true) })
    expect(server.ui.snapshot).toMatchObject({ draft: snapshot.draft, open: false })

    await act(async () => { cancelDraftShutdown(); cancelDraftShutdown() })
    expect(sources.filter(source => !source.closed)).toHaveLength(1)
    expect(sources).toHaveLength(2)
    const resumed = sources.find(source => !source.closed)!
    await act(async () => { oldCallback(navigation('old-source-after-resume')); resumed.onmessage!(navigation('already-seen')) })
    expect(onOpenBox).toHaveBeenCalledOnce()
    await act(async () => resumed.onmessage!(navigation('new-live-event')))
    expect(onOpenBox).toHaveBeenCalledTimes(2)
    expect(actions).toEqual(['ui']); expect(onOpenCoworker).not.toHaveBeenCalled()
    expect(server.ui.snapshot).toMatchObject({ draft: snapshot.draft })
})

it('shows the saved connection failure with a Settings action and clears it when a newer run settles', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    vi.stubGlobal('EventSource', Source)
    const chat = { workspaceId: '1', chatId: 'fmc_abcdefgh' }
    const server = { chat, sessionId: 'session', model: null, messages: [], runFailure: 'unauthorized' as string | null,
        view: { contractVersion: 1, chat, phase: 'plan', live: null, revisions: [], currentRevisionId: null, decisions: [], build: null, discovery: null, blocked: null },
        ui: { revision: 0, snapshot: null },
    }
    const fetch = vi.fn(async (_url: string, _init?: RequestInit) => Response.json(server))
    vi.stubGlobal('fetch', fetch)
    const onOpenModelSettings = vi.fn()
    root = createRoot(document.body.appendChild(document.createElement('div')))
    await act(async () => root!.render(<DesktopForemanPanel onClose={vi.fn()} onOpenCoworker={vi.fn()} onOpenCalledChat={vi.fn()} onOpenBox={vi.fn()}
        agentNameOf={id => id} onOpenModelSettings={onOpenModelSettings} />))
    const alert = document.querySelector('[role="alert"]')
    expect(alert?.textContent).toContain('Connection signed out')
    expect(alert?.textContent).toContain('This connection needs to be signed in again')
    await act(async () => alert?.querySelector('button')?.click())
    expect(onOpenModelSettings).toHaveBeenCalledOnce()
    expect(fetch.mock.calls.every(([, init]) => !init?.body)).toBe(true)

    server.runFailure = null
    await act(async () => vi.advanceTimersByTimeAsync(1500))
    expect(document.querySelector('[role="alert"]')).toBeNull()
})

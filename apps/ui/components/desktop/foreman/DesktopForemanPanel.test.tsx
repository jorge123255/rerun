// @vitest-environment happy-dom
import { randomUUID } from 'node:crypto'
import { StrictMode, act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { DesktopForemanPanel } from './DesktopForemanPanel'
import type { DesktopForemanColumnProps } from './DesktopForemanColumn'
import { cancelDraftShutdown } from '@/lib/desktop/draft-writes'
import { flushDesktopForemanUiSaves } from '@/lib/desktop/foreman-client'
let column: DesktopForemanColumnProps
vi.mock('./DesktopForemanColumn', () => ({ DesktopForemanColumn: (props: DesktopForemanColumnProps) => { column = props; return <button onClick={props.onClose}>Close Foreman</button> } }))
let root: Root | undefined
const sources: Array<{ closed: boolean }> = []
class Source {
    closed = false
    onmessage: ((event: { data: string }) => void) | null = null
    constructor(readonly url: string) { sources.push(this) }
    close() { this.closed = true }
}
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = undefined; await flushDesktopForemanUiSaves(); document.body.innerHTML = ''; vi.unstubAllGlobals(); cancelDraftShutdown(); sources.length = 0 })
it('keeps a usable exact-chat adapter through StrictMode and closes every live subscription on unmount', async () => {
    cancelDraftShutdown(); vi.stubGlobal('crypto', { randomUUID }); vi.stubGlobal('EventSource', Source)
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
    await act(async () => root!.render(<StrictMode><DesktopForemanPanel onClose={onClose} onOpenCoworker={onOpenCoworker} onOpenBox={onOpenBox} agentNameOf={id => id} /></StrictMode>))
    expect(column.messages).toEqual([{ id: 'message', role: 'user', text: 'A saved message' }])
    await act(async () => { expect(await column.ports.conversation.sendMessage('hello')).toBe(true) })
    expect(sends).toHaveLength(1); expect(onOpenCoworker).not.toHaveBeenCalled(); expect(onOpenBox).not.toHaveBeenCalled()
    await act(async () => document.querySelector<HTMLButtonElement>('button')!.click())
    expect(onClose).toHaveBeenCalledTimes(1)
    await act(async () => root!.unmount()); root = undefined
    expect(sources.length).toBeGreaterThan(0); expect(sources.every(source => source.closed)).toBe(true)
})

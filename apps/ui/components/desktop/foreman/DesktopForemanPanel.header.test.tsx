// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import type { DesktopForemanChatRef } from '@rerun/contracts'
import { DesktopForemanPanel } from './DesktopForemanPanel'
import type { DesktopForemanColumnProps } from './DesktopForemanColumn'
import { cancelDraftShutdown } from '@/lib/desktop/draft-writes'
import { flushDesktopForemanUiSaves } from '@/lib/desktop/foreman-client'
let column: DesktopForemanColumnProps
vi.mock('./DesktopForemanColumn', () => ({ DesktopForemanColumn: (props: DesktopForemanColumnProps) => {
    column = props
    return <><div data-header-crumb>{props.headerCrumb}</div><div data-header-actions>{props.headerActions}</div></>
} }))
let root: Root | undefined
class Source { onmessage = null; close() {} }
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = undefined; await flushDesktopForemanUiSaves(); document.body.innerHTML = ''; vi.unstubAllGlobals(); cancelDraftShutdown() })

const home = { workspaceId: '1', chatId: 'fmc_00000000-0000-4000-8000-000000000000' }
const stateOf = (chat: DesktopForemanChatRef, thread: boolean, extra: Record<string, unknown> = {}) => ({ chat, sessionId: 'session', model: null,
    // General is past its company questions; a new task has nothing in it yet.
    messages: thread ? [] : [{ id: 'message', role: 'user', parts: [{ type: 'text', text: 'A saved message' }] }], ...(thread && { separateConversation: true }),
    view: { contractVersion: 1, chat, phase: 'plan', live: null, revisions: [], currentRevisionId: null, decisions: [], build: null, discovery: null, blocked: null },
    ui: { revision: 0, snapshot: null }, ...extra })
const settle = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 10)) })

async function mount(target: DesktopForemanChatRef | null, onSelect: (chat: DesktopForemanChatRef | null) => Promise<void>, extra?: Record<string, unknown>) {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    vi.stubGlobal('EventSource', Source)
    const posts: string[] = []
    const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
        if (url.startsWith('/api/desktop/foreman/conversations')) {
            if (init?.method !== 'POST') return Response.json({ conversations: [{ chat: home, title: null, home: true }, ...(target ? [{ chat: target, title: null, home: false }] : [])] })
            const body = JSON.parse(String(init.body)) as { requestId: string }
            posts.push(body.requestId)
            return Response.json({ chat: { workspaceId: '1', chatId: `fmc_${body.requestId}` } })
        }
        if (url.startsWith('/api/desktop/foreman/file-permissions')) return Response.json({}, { status: 500 })
        return Response.json(stateOf(target ?? home, !!target, extra))
    })
    vi.stubGlobal('fetch', fetcher)
    root = createRoot(document.body.appendChild(document.createElement('div')))
    await act(async () => root!.render(<DesktopForemanPanel key={target?.chatId ?? 'home'} target={target} onSelectConversation={onSelect} controlledOpen
        onClose={vi.fn()} onOpenCoworker={vi.fn()} onOpenCalledChat={vi.fn()} onOpenBox={vi.fn()} agentNameOf={id => id} />))
    await settle()
    return { posts, fetcher }
}
const actions = () => document.querySelector<HTMLElement>('[data-header-actions]')!

it('carries New task, the clock and an overflow menu in the header, with Permissions behind the menu', async () => {
    const onSelect = vi.fn(async (_chat: DesktopForemanChatRef | null) => {})
    const { posts, fetcher } = await mount(null, onSelect)
    expect(document.querySelector('[data-header-crumb]')!.textContent).toBe('')
    expect(actions().querySelector('button[aria-label="Conversations"]')).not.toBeNull()
    // Nothing in the header row reads « Permissions » any more.
    expect(actions().textContent).toBe('New task')
    const more = actions().querySelector<HTMLButtonElement>('button[aria-label="More"]')!
    more.focus()
    await act(async () => { more.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })) })
    await settle()
    const item = document.querySelector<HTMLElement>('[role="menuitem"][data-foreman-permissions]')!
    expect(item.textContent).toBe('Permissions')
    await act(async () => { item.click() })
    await settle()
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Chief of Staff permissions')
    expect(fetcher.mock.calls.some(call => String(call[0]).startsWith('/api/desktop/foreman/file-permissions'))).toBe(true)

    await act(async () => { actions().querySelector<HTMLButtonElement>('[data-foreman-new-task]')!.click() })
    await settle()
    expect(posts).toHaveLength(1)
    expect(onSelect).toHaveBeenCalledExactlyOnceWith({ workspaceId: '1', chatId: `fmc_${posts[0]}` })
})

it('opens the new task on « General / New task » with the caret in the composer, and does not stack empty tasks', async () => {
    const onSelect = vi.fn(async (_chat: DesktopForemanChatRef | null) => {})
    const first = await mount(null, onSelect)
    await act(async () => { actions().querySelector<HTMLButtonElement>('[data-foreman-new-task]')!.click() })
    await settle()
    const task = onSelect.mock.calls[0]![0]!
    await act(async () => root!.unmount()); root = undefined; document.body.innerHTML = ''
    expect(first.posts).toHaveLength(1)

    const second = await mount(task, onSelect)
    expect(document.querySelector('[data-foreman-thread-crumb]')!.textContent).toBe('General/New task')
    expect(column.headerCrumb).toBeTruthy()
    expect(column.separateConversation).toBe(true)
    expect(column.focusRequest).toBe(`new-task:${task.chatId}`)
    // The task has no message yet: pressing New task again goes back to its composer.
    await act(async () => { actions().querySelector<HTMLButtonElement>('[data-foreman-new-task]')!.click() })
    await settle()
    expect(second.posts).toHaveLength(0)
    expect(onSelect).toHaveBeenCalledOnce()
    expect(column.focusRequest).not.toBe(`new-task:${task.chatId}`)
    expect(column.focusRequest).toMatch(/^new-task:/)
})

it('marks a conversation that waits on the person with the amber dot on the clock', async () => {
    const question = { id: 'a'.repeat(64), messageId: 'saved-question', toolCallId: 'question-call', questions: [{ question: 'Which time?', options: ['Morning', 'Afternoon'] }] }
    await mount(null, vi.fn(async () => {}), { question })
    expect(actions().querySelector('button[aria-label="Conversations"] [data-foreman-waiting]')).not.toBeNull()
})

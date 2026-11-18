// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import type { DesktopForemanChatRef } from '@rerun/contracts'
import { DesktopForemanPanel } from './DesktopForemanPanel'
import type { DesktopForemanColumnProps } from './DesktopForemanColumn'
import { DESKTOP_CONNECTOR_APPS_CHANGED } from '@/lib/desktop/use-connector-apps'
import { cancelDraftShutdown } from '@/lib/desktop/draft-writes'
import { flushDesktopForemanUiSaves } from '@/lib/desktop/foreman-client'
let column: DesktopForemanColumnProps
vi.mock('./DesktopForemanColumn', () => ({ DesktopForemanColumn: (props: DesktopForemanColumnProps) => {
    column = props
    return <><div data-header-crumb>{props.headerCrumb}</div><div data-header-actions>{props.headerActions}</div></>
} }))
let root: Root | undefined
let actionsPosted: { action: string; model?: unknown }[] = [], modelSaves = true
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
    actionsPosted = []
    const posts: string[] = []
    const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
        if (url.startsWith('/api/desktop/foreman/conversations')) {
            if (init?.method !== 'POST') return Response.json({ conversations: [{ chat: home, title: null, home: true }, ...(target ? [{ chat: target, title: null, home: false }] : [])] })
            const body = JSON.parse(String(init.body)) as { requestId: string }
            posts.push(body.requestId)
            return Response.json({ chat: { workspaceId: '1', chatId: `fmc_${body.requestId}` } })
        }
        if (url.startsWith('/api/desktop/foreman/apps?')) return Response.json({ chat: home, apps: [{ id: '50000000-0000-4000-8000-000000000001', name: 'Linear', label: 'Shared Linear' }] })
        if (url.startsWith('/api/desktop/foreman/file-permissions')) return Response.json({}, { status: 500 })
        if (url === '/api/desktop/foreman' && init?.method === 'POST') {
            const body = JSON.parse(String(init.body)) as { action: string; model?: unknown }
            actionsPosted.push(body)
            return body.action === 'model' && modelSaves ? Response.json({ model: body.model }) : Response.json({ error: 'The model is unavailable.' }, { status: 409 })
        }
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

    expect(posts).toHaveLength(0)
    expect(onSelect).not.toHaveBeenCalled()
})

it('opens the Chief’s read-only shared Apps list from the board header', async () => {
    const { fetcher } = await mount(null, vi.fn(async () => {}))
    const more = actions().querySelector<HTMLButtonElement>('button[aria-label="More"]')!
    more.focus()
    await act(async () => { more.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })) })
    await settle()
    const apps = document.querySelector<HTMLElement>('[role="menuitem"][data-foreman-apps]')
    expect(apps?.textContent).toBe('Apps')
    await act(async () => { apps!.click() })
    await settle()
    const dialog = document.querySelector('[role="dialog"]')!
    expect(dialog.querySelector('[aria-label="Apps shared with everyone"]')?.textContent).toContain('Shared Linear')
    expect(dialog.querySelector('[role="switch"], button[aria-label^="Add "], button[aria-label^="Remove "]')).toBeNull()
    expect(fetcher.mock.calls.some(([url]) => String(url) === '/api/desktop/vault')).toBe(false)
    // While open, a Vault change must remove the old label even when its refreshed read fails.
    fetcher.mockResolvedValueOnce(Response.json({}, { status: 409 }))
    await act(async () => { window.dispatchEvent(new Event(DESKTOP_CONNECTOR_APPS_CHANGED)) })
    expect(dialog.textContent).not.toContain('Shared Linear')
    expect(dialog.querySelector('[role="alert"]')?.textContent).toBe('Could not load shared apps.')
    fetcher.mockResolvedValueOnce(Response.json({ chat: home, apps: [] }))
    await act(async () => { dialog.querySelector<HTMLButtonElement>('[role="alert"] + button')!.click() })
    expect(dialog.textContent).toContain('No apps are shared with everyone.')
})

const newTask = async () => { await act(async () => { actions().querySelector<HTMLButtonElement>('[data-foreman-new-task]')!.click() }); await settle() }
const crumbText = () => document.querySelector('[data-foreman-thread-crumb]')?.textContent ?? null

it('opens New task as a draft: « General / New task », an empty conversation with the caret, and nothing saved', async () => {
    const onSelect = vi.fn(async (_chat: DesktopForemanChatRef | null) => {})
    const { posts, fetcher } = await mount(null, onSelect)
    expect(column.chat).toEqual(home)
    const reads = fetcher.mock.calls.length
    await newTask()
    expect(crumbText()).toBe('General/New task')
    const draft = column.chat
    expect(draft.workspaceId).toBe('1')
    expect(draft.chatId).not.toBe(home.chatId)
    expect(column.messages).toEqual([])
    expect(column.separateConversation).toBe(true)
    expect(column.focusRequest).toBe(`new-task:${draft.chatId}`)
    // Attachments and voice wait for the saved conversation.
    expect(column.sessionId).toBeUndefined()
    expect(column.voiceSlot).toBeUndefined()
    // Nothing was created, opened or read for it.
    expect(posts).toHaveLength(0)
    expect(onSelect).not.toHaveBeenCalled()
    expect(fetcher.mock.calls.length).toBe(reads)
    // Its interface state stays in memory.
    await column.ports.persistence.save({ ...draft, open: true, tab: 'assistant', draft: 'half a thought', pendingPlanRevisionId: null, decision: { status: 'idle' }, build: null, discoveries: null, placement: { mode: 'dock', side: 'right', width: 420, height: 640, dockWidth: 420 } })
    expect(fetcher.mock.calls.length).toBe(reads)

    // The list behind the clock shows it as the current row.
    await act(async () => { actions().querySelector<HTMLButtonElement>('button[aria-label="Conversations"]')!.click() })
    await settle()
    expect([...document.querySelectorAll('[data-foreman-history] [data-foreman-history-row]')].map(row => [row.textContent, row.getAttribute('aria-current')]))
        .toEqual([['General', null], ['New task', 'true']])
    await act(async () => { document.querySelector<HTMLButtonElement>('[data-foreman-history] button[aria-label="Close"]')!.click() })

    // New task on the empty draft goes back to its composer.
    await newTask()
    expect(column.chat).toEqual(draft)
    expect(column.focusRequest).not.toBe(`new-task:${draft.chatId}`)
    expect(column.focusRequest).toMatch(/^new-task:/)

    // Back to General drops it: General is read again, and still nothing was saved.
    await act(async () => { document.querySelector<HTMLButtonElement>('[data-foreman-thread-crumb] button[aria-label="Back to General"]')!.click() })
    await settle()
    expect(crumbText()).toBeNull()
    expect(column.chat).toEqual(home)
    expect(posts).toHaveLength(0)
    expect(onSelect).not.toHaveBeenCalled()
    // A new draft is a new one.
    await newTask()
    expect(column.chat.chatId).not.toBe(draft.chatId)
})

it('saves the task with its first message: the conversation is created, opened, and sends that message once', async () => {
    const onSelect = vi.fn(async (_chat: DesktopForemanChatRef | null) => {})
    const first = await mount(null, onSelect)
    await newTask()
    const draft = column.chat
    let accepted: boolean | undefined
    await act(async () => { accepted = await column.ports.conversation.sendMessage('Plan the launch') })
    expect(accepted).toBe(true)
    expect(first.posts).toHaveLength(1)
    const task = { workspaceId: '1', chatId: `fmc_${first.posts[0]}` }
    // The saved conversation is not the draft's on-screen identity.
    expect(task.chatId).not.toBe(draft.chatId)
    expect(onSelect).toHaveBeenCalledExactlyOnceWith(task)
    // The composer stays held until the saved conversation takes the panel.
    expect(column.sendDisabled).toBe(true)
    await act(async () => root!.unmount()); root = undefined; document.body.innerHTML = ''

    const second = await mount(task, onSelect)
    expect(crumbText()).toBe('General/New task')
    expect(column.chat).toEqual(task)
    expect(column.firstSend).toEqual({ id: task.chatId, text: 'Plan the launch', coworkerMentions: undefined, send: true })
    expect(column.focusRequest).toBe(`new-task:${task.chatId}`)
    expect(second.posts).toHaveLength(0)
    await act(async () => root!.unmount()); root = undefined; document.body.innerHTML = ''
    // Opening it again later sends nothing again.
    await mount(task, onSelect)
    expect(column.firstSend).toBeUndefined()
})

it('keeps the draft when the conversation cannot be created or opened, and a retry never creates a second one', async () => {
    const onSelect = vi.fn(async (_chat: DesktopForemanChatRef | null) => { throw new Error('Could not leave the current Chief of Staff conversation.') })
    const { posts } = await mount(null, onSelect)
    await newTask()
    const draft = column.chat
    await act(async () => { await expect(column.ports.conversation.sendMessage('Plan the launch')).rejects.toThrow('Could not leave') })
    expect(column.chat).toEqual(draft)
    expect(column.sendDisabled).toBe(false)
    expect(crumbText()).toBe('General/New task')
    await act(async () => { await expect(column.ports.conversation.sendMessage('Plan the launch')).rejects.toThrow('Could not leave') })
    expect(posts).toHaveLength(2)
    expect(posts[1]).toBe(posts[0])
    // The message was not left behind for another conversation to send.
    const { takeDesktopForemanFirstSend } = await import('@/lib/desktop/foreman-client/draft-task')
    expect(takeDesktopForemanFirstSend(`fmc_${posts[0]}`)).toBeNull()
})

it('saves the model picked in the draft on the new conversation before its first message is sent', async () => {
    const { createDesktopForemanDraftTask, sendDesktopForemanFirstMessage } = await import('@/lib/desktop/foreman-client/draft-task')
    const model = { connectionId: 'connection', model: 'model' }
    const leave = async (text: string) => {
        vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => Response.json({ chat: { workspaceId: '1', chatId: `fmc_${(JSON.parse(String(init!.body)) as { requestId: string }).requestId}` } })))
        return sendDesktopForemanFirstMessage(createDesktopForemanDraftTask('1'), { text, model }, async () => {}, new AbortController().signal)
    }
    modelSaves = true
    const task = await leave('Plan the launch')
    await mount(task, vi.fn(async () => {}))
    expect(actionsPosted).toEqual([{ action: 'model', chat: task, expected: null, model }])
    expect(column.firstSend).toEqual({ id: task.chatId, text: 'Plan the launch', coworkerMentions: undefined, send: true })
    await act(async () => root!.unmount()); root = undefined; document.body.innerHTML = ''

    // A model that cannot be saved holds the message in the composer instead of sending it with another one.
    modelSaves = false
    const other = await leave('Draft the memo')
    await mount(other, vi.fn(async () => {}))
    expect(actionsPosted.map(post => post.action)).toEqual(['model'])
    expect(column.firstSend).toEqual({ id: other.chatId, text: 'Draft the memo', coworkerMentions: undefined, send: false })
    modelSaves = true
})

it('drops the draft when the panel is closed', async () => {
    const onSelect = vi.fn(async (_chat: DesktopForemanChatRef | null) => {}), onClose = vi.fn()
    const { posts } = await mount(null, onSelect)
    await newTask()
    const draft = column.chat
    await act(async () => root!.render(<DesktopForemanPanel key="home" target={null} onSelectConversation={onSelect} controlledOpen={false}
        onClose={onClose} onOpenCoworker={vi.fn()} onOpenCalledChat={vi.fn()} onOpenBox={vi.fn()} agentNameOf={id => id} />))
    await settle()
    expect(column.chat).toEqual(home)
    await act(async () => root!.render(<DesktopForemanPanel key="home" target={null} onSelectConversation={onSelect} controlledOpen
        onClose={onClose} onOpenCoworker={vi.fn()} onOpenCalledChat={vi.fn()} onOpenBox={vi.fn()} agentNameOf={id => id} />))
    await settle()
    expect(column.chat).toEqual(home)
    expect(crumbText()).toBeNull()
    expect(column.chat.chatId).not.toBe(draft.chatId)
    expect(posts).toHaveLength(0)
})

it('a saved task nobody wrote in keeps New task on its own composer', async () => {
    const onSelect = vi.fn(async (_chat: DesktopForemanChatRef | null) => {})
    const task = { workspaceId: '1', chatId: 'fmc_00000000-0000-4000-8000-000000000009' }
    const { posts } = await mount(task, onSelect)
    expect(crumbText()).toBe('General/New task')
    await newTask()
    expect(column.chat).toEqual(task)
    expect(column.focusRequest).toMatch(/^new-task:/)
    expect(posts).toHaveLength(0)
    expect(onSelect).not.toHaveBeenCalled()
})

it('marks a conversation that waits on the person with the amber dot on the clock', async () => {
    const question = { id: 'a'.repeat(64), messageId: 'saved-question', toolCallId: 'question-call', questions: [{ question: 'Which time?', options: ['Morning', 'Afternoon'] }] }
    await mount(null, vi.fn(async () => {}), { question })
    expect(actions().querySelector('button[aria-label="Conversations"] [data-foreman-waiting]')).not.toBeNull()
})

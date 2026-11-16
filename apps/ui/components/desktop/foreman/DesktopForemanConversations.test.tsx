// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, test, vi } from 'vitest'
import type { DesktopForemanChatRef } from '@rerun/contracts'
import { DesktopForemanHistory, DesktopForemanNewTask, DesktopForemanThreadCrumb, useDesktopForemanConversations, type DesktopForemanThreadState } from './DesktopForemanConversations'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const home = { workspaceId: '1', chatId: 'fmc_00000000-0000-4000-8000-000000000000' }
const pricing = { workspaceId: '1', chatId: 'fmc_00000000-0000-4000-8000-000000000001' }
const launch = { workspaceId: '1', chatId: 'fmc_00000000-0000-4000-8000-000000000003' }
const blank = { workspaceId: '1', chatId: 'fmc_00000000-0000-4000-8000-000000000004' }
const today = new Date().toISOString()
const rows = [
    { chat: home, title: null, home: true },
    { chat: blank, title: null, home: false },
    { chat: launch, title: 'Launch plan', home: false, updatedAt: '2020-01-02T10:00:00.000Z', startedAt: '2020-01-01T09:00:00.000Z' },
    { chat: pricing, title: 'Pricing page', home: false, updatedAt: today, startedAt: today },
    { chat: { workspaceId: '2', chatId: 'fmc_00000000-0000-4000-8000-000000000002' }, title: 'Other workspace', home: false },
]
const roots: Root[] = []
afterEach(() => { for (const root of roots.splice(0)) act(() => { root.unmount() }); document.body.innerHTML = ''; vi.unstubAllGlobals() })

function Header({ chat, thread = false, emptyThread = false, draft = false, waiting = false, state = 'quiet', onSelect, onNewTask, onFocusComposer }: {
    chat: DesktopForemanChatRef; thread?: boolean; emptyThread?: boolean; draft?: boolean; waiting?: boolean; state?: DesktopForemanThreadState
    onSelect: (chat: DesktopForemanChatRef | null) => Promise<void>; onNewTask?: () => void; onFocusComposer?: () => void
}) {
    const conversations = useDesktopForemanConversations({ chat, thread, emptyThread, draft, onSelect, onNewTask, onFocusComposer })
    return <>
        {thread && <DesktopForemanThreadCrumb conversations={conversations} state={state} disabled={false} />}
        <DesktopForemanHistory conversations={conversations} waiting={waiting} disabled={false} />
        <DesktopForemanNewTask conversations={conversations} disabled={false} />
    </>
}
async function mount(node: React.ReactNode) {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    roots.push(root)
    await act(async () => { root.render(node) })
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 1)) })
    return host
}
const settle = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 5)) })
const openClock = async (host: HTMLElement) => {
    await act(async () => { host.querySelector<HTMLButtonElement>('button[aria-label="Conversations"]')!.click() })
    await settle()
    return [...document.querySelectorAll<HTMLButtonElement>('[data-foreman-history] [data-foreman-history-row]')]
}

test('General reads the list once for its branches, again when the clock opens, then pins General and groups this workspace\'s threads by day', async () => {
    const fetched = vi.fn(async () => Response.json({ conversations: rows }))
    vi.stubGlobal('fetch', fetched)
    const onSelect = vi.fn(async () => {})
    const host = await mount(<Header chat={home} onSelect={onSelect} />)
    expect(fetched).toHaveBeenCalledOnce()
    expect(host.querySelector('[data-foreman-thread-crumb]')).toBeNull()
    const items = await openClock(host)
    expect(fetched).toHaveBeenCalledTimes(2)
    const popover = document.querySelector<HTMLElement>('[data-foreman-history]')!
    expect(popover.className).toContain('w-[min(360px,calc(100vw-1.5rem))]')
    expect(popover.textContent).toContain('Conversations')
    expect(popover.querySelector('button[aria-label="Close"]')).not.toBeNull()
    // General first, then the most recent day. The task nobody ever wrote in is not listed.
    expect(items.map(item => [item.querySelector('.truncate')?.textContent, item.getAttribute('aria-current')]))
        .toEqual([['General', 'true'], ['Pricing page', null], ['Launch plan', null]])
    const days = [...popover.querySelectorAll('[data-foreman-history-day]')].map(day => day.textContent)
    expect(days).toHaveLength(2)
    expect(days[0]).toBe('Today')
    expect(popover.textContent).not.toContain('Other workspace')
    expect(popover.querySelector('[data-foreman-waiting]')).toBeNull()
    await act(async () => { items[1].click() })
    expect(onSelect).toHaveBeenCalledExactlyOnceWith(pricing)
    expect(document.querySelector('[data-foreman-history]')).toBeNull()
})

test('a thread names itself on its own row beside the way back to General, with its state dot', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ conversations: rows })))
    const onSelect = vi.fn(async () => {})
    const host = await mount(<Header chat={pricing} thread state="needs" waiting onSelect={onSelect} />)
    const crumb = host.querySelector('[data-foreman-thread-crumb]')!
    expect(crumb.textContent).toBe('General/Pricing page')
    expect(crumb.querySelector('[data-foreman-thread-state="needs"] .bg-amber-400')).not.toBeNull()
    // The clock carries the amber dot, and so does the waiting conversation's own row.
    expect(host.querySelector('button[aria-label="Conversations"] [data-foreman-waiting]')).not.toBeNull()
    const items = await openClock(host)
    expect(items.filter(item => item.querySelector('[data-foreman-waiting]')).map(item => item.querySelector('.truncate')?.textContent)).toEqual(['Pricing page'])
    await act(async () => { crumb.querySelector<HTMLButtonElement>('button[aria-label="Back to General"]')!.click() })
    expect(onSelect).toHaveBeenCalledExactlyOnceWith(null)
})

test('an untitled thread reads « General / New task »', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ conversations: rows })))
    const host = await mount(<Header chat={blank} thread onSelect={vi.fn(async () => {})} />)
    expect(host.querySelector('[data-foreman-thread-crumb]')!.textContent).toBe('General/New task')
    expect(host.querySelector('[data-foreman-thread-state]')).toBeNull()
})

test('New task in the header saves nothing: it asks for the draft, and creates no conversation', async () => {
    const fetched = vi.fn(async () => Response.json({ conversations: rows }))
    vi.stubGlobal('fetch', fetched)
    const onSelect = vi.fn(async (_chat: DesktopForemanChatRef | null) => {}), onNewTask = vi.fn()
    const host = await mount(<Header chat={home} onSelect={onSelect} onNewTask={onNewTask} />)
    const button = host.querySelector<HTMLButtonElement>('[data-foreman-new-task]')!
    expect(button.textContent).toBe('New task')
    await act(async () => { button.click() })
    await settle()
    expect(onNewTask).toHaveBeenCalledOnce()
    expect(onSelect).not.toHaveBeenCalled()
    // General's own read of the list is the only request: nothing is written.
    expect((fetched.mock.calls as unknown as [string, RequestInit?][]).every(([, init]) => !init?.method && !init?.body)).toBe(true)
    // The same from the list behind the clock.
    await openClock(host)
    await act(async () => { [...document.querySelectorAll<HTMLButtonElement>('[data-foreman-history] button')].find(item => item.textContent?.trim() === 'New task')!.click() })
    expect(onNewTask).toHaveBeenCalledTimes(2)
    expect(document.querySelector('[data-foreman-history]')).toBeNull()
    expect(fetched.mock.calls.every(call => (call as unknown as [string, RequestInit?])[1]?.method !== 'POST')).toBe(true)
})

test('the unsaved new task is the current row while it is open, under General, and New task returns to its composer', async () => {
    const fetched = vi.fn(async () => Response.json({ conversations: rows }))
    vi.stubGlobal('fetch', fetched)
    const draft = { workspaceId: '1', chatId: 'fmc_00000000-0000-4000-8000-00000000000d' }
    const onSelect = vi.fn(async () => {}), focus = vi.fn(), onNewTask = vi.fn()
    const host = await mount(<Header chat={draft} thread emptyThread draft onSelect={onSelect} onNewTask={onNewTask} onFocusComposer={focus} />)
    // A draft has no saved title to read.
    expect(fetched).not.toHaveBeenCalled()
    const crumb = host.querySelector('[data-foreman-thread-crumb]')!
    expect(crumb.textContent).toBe('General/New task')
    const items = await openClock(host)
    expect(items.map(item => [item.textContent, item.getAttribute('aria-current')]).slice(0, 3))
        .toEqual([['General', null], ['New task', 'true'], [expect.stringContaining('Pricing page'), null]])
    expect([...document.querySelectorAll('[data-foreman-history] [aria-current=true]')].map(item => (item as HTMLElement).textContent!.trim().split('\n')[0]).join()).toBe('New task')
    await act(async () => { items[1].click() })
    expect(focus).toHaveBeenCalledOnce()
    expect(document.querySelector('[data-foreman-history]')).toBeNull()
    await act(async () => { host.querySelector<HTMLButtonElement>('[data-foreman-new-task]')!.click() })
    expect(focus).toHaveBeenCalledTimes(2)
    expect(onNewTask).not.toHaveBeenCalled()
    expect(onSelect).not.toHaveBeenCalled()
    await act(async () => { crumb.querySelector<HTMLButtonElement>('button[aria-label="Back to General"]')!.click() })
    expect(onSelect).toHaveBeenCalledExactlyOnceWith(null)
})

test('a draft in a workspace with no thread is listed alone, without « No thread yet. »', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ conversations: [rows[0]] })))
    const draft = { workspaceId: '1', chatId: 'fmc_00000000-0000-4000-8000-00000000000d' }
    const host = await mount(<Header chat={draft} thread emptyThread draft onSelect={vi.fn(async () => {})} />)
    const items = await openClock(host)
    expect(items.map(item => item.textContent)).toEqual(['General', 'New task'])
    expect(document.body.textContent).not.toContain('No thread yet.')
})

test('an empty task left by the old New task is listed only while it is the one on screen', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ conversations: rows })))
    const host = await mount(<Header chat={blank} thread emptyThread onSelect={vi.fn(async () => {})} />)
    const items = await openClock(host)
    expect(items.map(item => [item.querySelector('.truncate')?.textContent, item.getAttribute('aria-current')]))
        .toEqual([['General', null], ['New task', 'true'], ['Pricing page', null], ['Launch plan', null]])
})

test('New task on a task nobody wrote in yet returns to its composer instead of opening another', async () => {
    const fetched = vi.fn(async () => Response.json({ conversations: rows }))
    vi.stubGlobal('fetch', fetched)
    const onSelect = vi.fn(async () => {}), focus = vi.fn()
    const host = await mount(<Header chat={blank} thread emptyThread onSelect={onSelect} onFocusComposer={focus} />)
    await act(async () => { host.querySelector<HTMLButtonElement>('[data-foreman-new-task]')!.click() })
    expect(focus).toHaveBeenCalledOnce()
    expect(onSelect).not.toHaveBeenCalled()
    expect(fetched.mock.calls.every(call => (call as unknown as [string, RequestInit?])[1]?.method !== 'POST')).toBe(true)
})

test('a workspace with only General says there is no thread yet', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ conversations: [rows[0]] })))
    const host = await mount(<Header chat={home} onSelect={vi.fn(async () => {})} />)
    await openClock(host)
    expect(document.body.textContent).toContain('No thread yet.')
})

function Branches({ chat, thread = false, draft = false, seen }: { chat: DesktopForemanChatRef; thread?: boolean; draft?: boolean; seen: (value: ReturnType<typeof useDesktopForemanConversations>) => void }) {
    const conversations = useDesktopForemanConversations({ chat, thread, draft, onSelect: async () => {} })
    seen(conversations)
    return <DesktopForemanHistory conversations={conversations} disabled={false} />
}

test('General lists its saved tasks as branches: none without a message, none from another workspace, none for a thread or a draft', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ conversations: rows })))
    let last!: ReturnType<typeof useDesktopForemanConversations>
    await mount(<Branches chat={home} seen={value => { last = value }} />)
    expect(last.branches).toEqual([
        { chat: launch, title: 'Launch plan', createdAt: '2020-01-01T09:00:00.000Z', updatedAt: '2020-01-02T10:00:00.000Z' },
        { chat: pricing, title: 'Pricing page', createdAt: today, updatedAt: today },
    ])
    await mount(<Branches chat={pricing} thread seen={value => { last = value }} />)
    expect(last.branches).toEqual([])
    await mount(<Branches chat={blank} thread draft seen={value => { last = value }} />)
    expect(last.branches).toEqual([])
})

test('a failed read for the branches says nothing in the header', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 500 })))
    let last!: ReturnType<typeof useDesktopForemanConversations>
    const host = await mount(<Branches chat={home} seen={value => { last = value }} />)
    expect(last.branches).toEqual([])
    expect(last.error).toBeNull()
    expect(host.querySelector('[role="alert"]')).toBeNull()
})

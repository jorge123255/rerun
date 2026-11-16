// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, test, vi } from 'vitest'
import type { DesktopForemanChatRef } from '@rerun/contracts'
import { DesktopForemanHistory, DesktopForemanNewTask, DesktopForemanThreadCrumb, takeDesktopForemanNewTaskFocus, useDesktopForemanConversations, type DesktopForemanThreadState } from './DesktopForemanConversations'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const home = { workspaceId: '1', chatId: 'fmc_00000000-0000-4000-8000-000000000000' }
const pricing = { workspaceId: '1', chatId: 'fmc_00000000-0000-4000-8000-000000000001' }
const launch = { workspaceId: '1', chatId: 'fmc_00000000-0000-4000-8000-000000000003' }
const blank = { workspaceId: '1', chatId: 'fmc_00000000-0000-4000-8000-000000000004' }
const today = new Date().toISOString()
const rows = [
    { chat: home, title: null, home: true },
    { chat: blank, title: null, home: false },
    { chat: launch, title: 'Launch plan', home: false, updatedAt: '2020-01-02T10:00:00.000Z' },
    { chat: pricing, title: 'Pricing page', home: false, updatedAt: today },
    { chat: { workspaceId: '2', chatId: 'fmc_00000000-0000-4000-8000-000000000002' }, title: 'Other workspace', home: false },
]
const roots: Root[] = []
afterEach(() => { for (const root of roots.splice(0)) act(() => { root.unmount() }); document.body.innerHTML = ''; vi.unstubAllGlobals() })

function Header({ chat, thread = false, emptyThread = false, waiting = false, state = 'quiet', onSelect, onFocusComposer }: {
    chat: DesktopForemanChatRef; thread?: boolean; emptyThread?: boolean; waiting?: boolean; state?: DesktopForemanThreadState
    onSelect: (chat: DesktopForemanChatRef | null) => Promise<void>; onFocusComposer?: () => void
}) {
    const conversations = useDesktopForemanConversations({ chat, thread, emptyThread, onSelect, onFocusComposer })
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

test('General reads nothing until the clock opens, then pins General and groups this workspace\'s threads by day', async () => {
    const fetched = vi.fn(async () => Response.json({ conversations: rows }))
    vi.stubGlobal('fetch', fetched)
    const onSelect = vi.fn(async () => {})
    const host = await mount(<Header chat={home} onSelect={onSelect} />)
    expect(fetched).not.toHaveBeenCalled()
    expect(host.querySelector('[data-foreman-thread-crumb]')).toBeNull()
    const items = await openClock(host)
    expect(fetched).toHaveBeenCalledOnce()
    const popover = document.querySelector<HTMLElement>('[data-foreman-history]')!
    expect(popover.className).toContain('w-[min(360px,calc(100vw-1.5rem))]')
    expect(popover.textContent).toContain('Conversations')
    expect(popover.querySelector('button[aria-label="Close"]')).not.toBeNull()
    // General first, the task nobody wrote in yet, then the most recent day.
    expect(items.map(item => [item.querySelector('.truncate')?.textContent, item.getAttribute('aria-current')]))
        .toEqual([['General', 'true'], ['New task', null], ['Pricing page', null], ['Launch plan', null]])
    const days = [...popover.querySelectorAll('[data-foreman-history-day]')].map(day => day.textContent)
    expect(days).toHaveLength(2)
    expect(days[0]).toBe('Today')
    expect(popover.textContent).not.toContain('Other workspace')
    expect(popover.querySelector('[data-foreman-waiting]')).toBeNull()
    await act(async () => { items[2].click() })
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

test('New task in the header opens a new conversation once and hands it the caret', async () => {
    const posted = vi.fn()
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
        const body = JSON.parse(String(init!.body)) as { workspaceId: string; requestId: string }
        posted(init!.method, body.workspaceId)
        return Response.json({ chat: { workspaceId: '1', chatId: `fmc_${body.requestId}` } })
    }))
    const onSelect = vi.fn(async (_chat: DesktopForemanChatRef | null) => {})
    const host = await mount(<Header chat={home} onSelect={onSelect} />)
    const button = host.querySelector<HTMLButtonElement>('[data-foreman-new-task]')!
    expect(button.textContent).toBe('New task')
    await act(async () => { button.click() })
    await settle()
    expect(posted).toHaveBeenCalledExactlyOnceWith('POST', '1')
    const created = onSelect.mock.calls[0]![0]!
    expect(created.chatId).toMatch(/^fmc_/)
    expect(takeDesktopForemanNewTaskFocus(created.chatId)).toBe(true)
    expect(takeDesktopForemanNewTaskFocus(created.chatId)).toBe(false)
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

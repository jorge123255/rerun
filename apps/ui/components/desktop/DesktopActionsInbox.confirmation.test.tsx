// @vitest-environment happy-dom

import { act, type ComponentProps, type MouseEvent as ReactMouseEvent } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { cancelDraftShutdown, flushDesktopDrafts } from '@/lib/desktop/draft-writes'
import { readTargetOf, type DesktopPendingInboxItem, type DesktopPendingReadTarget } from '@/lib/desktop/pending-inbox'
import type { DesktopCompletionItem } from '@/lib/desktop/completed-actions'
import { DesktopActionsInbox, type DesktopActionsInboxProps } from './DesktopActionsInbox'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// Keep the original Radix portal, focus scope and buttons. Capture only the public callback so
// retained-callback regressions can exercise a late event after its confirmation was dismissed.
const captured = vi.hoisted(() => ({ confirm: undefined as (() => void) | undefined }))
vi.mock('@/components/dialogs/ConfirmDialog', async importOriginal => {
    const actual = await importOriginal<typeof import('@/components/dialogs/ConfirmDialog')>()
    return {
        ...actual,
        ConfirmDialog(props: ComponentProps<typeof actual.ConfirmDialog>) {
            if (props.open) captured.confirm = () => props.onConfirm({} as ReactMouseEvent<HTMLButtonElement>)
            return <actual.ConfirmDialog {...props} />
        },
    }
})

const at = '2026-11-04T12:00:00.000Z'
const pending = (id = 'request-one'): DesktopPendingInboxItem => ({ id, kind: 'question', agentId: 'a', agentName: 'Alice', agentEnabled: true, sessionId: 'chat-one', title: 'Question', summary: id, updatedAt: at })
const done: DesktopCompletionItem = { id: 'done-one', agentId: 'a', agentName: 'Alice', agentEnabled: true, sessionId: 'chat-two', sessionIds: ['chat-two'], title: 'Finished', message: 'Done', source: 'chat', slug: null, count: 1, completedAt: at, completionIds: ['run-one'] }
const roots: Root[] = []
const dialog = () => document.querySelector<HTMLElement>('[role="alertdialog"]')
const panel = (container: HTMLElement) => container.querySelector('[aria-label="Actions inbox"]')
const pill = (container: HTMLElement) => container.querySelector<HTMLButtonElement>('button[aria-label^="Actions:"]')!
const markAll = (container: HTMLElement) => container.querySelector<HTMLButtonElement>('button[aria-label="Mark all as read"]')!
const dialogButton = (label: string) => [...dialog()!.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.trim() === label)!
const click = async (target: HTMLElement) => { await act(async () => { target.click() }) }
const pointerClick = async (target: HTMLElement) => {
    // Separate discrete events: a pointer-down close must have time to rerender before click.
    await act(async () => { target.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true, button: 0 })) })
    await click(target)
}
const tick = async () => { await act(async () => { await vi.advanceTimersByTimeAsync(3000) }) }

beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    captured.confirm = undefined
})
afterEach(async () => {
    await act(async () => { for (const root of roots.splice(0)) root.unmount(); cancelDraftShutdown() })
    document.body.innerHTML = ''; vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers()
})

function fixture() {
    let rows = [pending()]
    const pendingWrites: DesktopPendingReadTarget[][] = []
    const doneWrites: string[][] = []
    const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
        if (url === '/api/desktop/pending-inbox/read') {
            const targets = JSON.parse(String(init?.body)).items as DesktopPendingReadTarget[]
            pendingWrites.push(targets)
            return Response.json({ marked: targets.length, failedIds: [] })
        }
        if (url === '/api/desktop/completions/read') {
            doneWrites.push(JSON.parse(String(init?.body)).completionIds)
            return Response.json({ marked: 1 })
        }
        if (url === '/api/desktop/completions') return Response.json({ items: [done], unavailableAgentIds: [], enabledAt: at, nextCursor: null, checkedAt: at })
        expect(url).toBe('/api/desktop/pending-inbox')
        return Response.json({ items: rows, unavailableAgentIds: [], checkedAt: at })
    })
    vi.stubGlobal('fetch', fetcher)
    return { pendingWrites, doneWrites, setRows: (next: DesktopPendingInboxItem[]) => { rows = next } }
}

async function mount(props: DesktopActionsInboxProps = {}) {
    const container = document.createElement('div'); document.body.append(container)
    const root = createRoot(container); roots.push(root)
    const render = async (next: DesktopActionsInboxProps = props) => {
        props = next
        await act(async () => { root.render(<DesktopActionsInbox {...props} />) })
    }
    await render()
    return { container, render }
}

test('the real confirmation portal survives pointer-down and confirms captured pending and Done rows', async () => {
    const f = fixture(), h = await mount()
    await click(pill(h.container))
    await click(markAll(h.container))
    expect(dialog()?.textContent).toContain('Mark everything as read?')
    expect(dialog()?.textContent).toContain('2 items will leave this list. Requests still waiting on an answer are cleared too, without being answered.')
    expect(h.container.contains(dialog())).toBe(false)
    expect(f.pendingWrites).toEqual([]); expect(f.doneWrites).toEqual([])
    f.setRows([pending(), pending('arrived-during-confirmation')]); await tick()
    expect(dialog()?.textContent).toContain('2 items will leave this list.')
    const confirm = dialogButton('Mark all as read')
    await act(async () => { confirm.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true, button: 0 })) })
    expect(panel(h.container)).not.toBeNull()
    expect(dialog()).not.toBeNull()
    await click(confirm)
    expect(f.pendingWrites).toEqual([[readTargetOf(pending())]])
    expect(f.doneWrites).toEqual([['run-one']])
    expect(panel(h.container)).not.toBeNull()
    expect(dialog()).toBeNull()
    expect(h.container.querySelector('[data-actions-inbox-item="arrived-during-confirmation"]')).not.toBeNull()
})

test.each(['Cancel', 'Escape'] as const)('%s dismisses only the confirmation and acknowledges nothing', async cancel => {
    const f = fixture(), h = await mount()
    await click(pill(h.container)); await click(markAll(h.container))
    if (cancel === 'Cancel') await pointerClick(dialogButton('Cancel'))
    else await act(async () => { dialog()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })) })
    expect(dialog()).toBeNull()
    expect(panel(h.container)).not.toBeNull()
    expect(f.pendingWrites).toEqual([]); expect(f.doneWrites).toEqual([])
    // Once the confirmation is gone, Escape resumes the inbox's normal close behavior.
    await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })) })
    expect(panel(h.container)).toBeNull()
})

test.each(['close and reopen', 'roster A to B to A', 'visible chat changes'] as const)('a confirmation expires when %s, and its late callback cannot clear a newer confirmation', async transition => {
    const f = fixture(), agents = [{ id: 'a', name: 'Alice', enabled: true }]
    const base: DesktopActionsInboxProps = { open: true, agents }
    const h = await mount(base)
    await click(markAll(h.container))
    const oldConfirm = captured.confirm!
    if (transition === 'close and reopen') {
        await h.render({ ...base, open: false }); expect(dialog()).toBeNull()
        await h.render(base)
    } else if (transition === 'roster A to B to A') {
        await h.render({ ...base, agents: [{ id: 'b', name: 'Bob', enabled: true }] }); expect(dialog()).toBeNull()
        await h.render(base)
    } else {
        await h.render({ ...base, visibleSessionId: 'unrelated-chat' }); expect(dialog()).toBeNull()
    }
    f.setRows([pending('new-request')]); await tick()
    await click(markAll(h.container))
    const currentConfirm = captured.confirm!
    await act(async () => { oldConfirm() })
    expect(f.pendingWrites).toEqual([]); expect(f.doneWrites).toEqual([])
    expect(dialog()).not.toBeNull()
    await act(async () => { currentConfirm() })
    expect(f.pendingWrites).toEqual([[readTargetOf(pending('new-request'))]])
    expect(f.doneWrites).toEqual([['run-one']])
})

test('Cancel then reopen in the same lifecycle rejects the older confirmation without clearing the newer one', async () => {
    const f = fixture(), h = await mount({ open: true })
    await click(markAll(h.container))
    const oldConfirm = captured.confirm!
    await pointerClick(dialogButton('Cancel'))
    f.setRows([pending('new-request')]); await tick()
    await click(markAll(h.container))
    const currentConfirm = captured.confirm!
    await act(async () => { oldConfirm() })
    expect(f.pendingWrites).toEqual([]); expect(f.doneWrites).toEqual([])
    expect(dialog()).not.toBeNull()
    await act(async () => { currentConfirm() })
    expect(f.pendingWrites).toEqual([[readTargetOf(pending('new-request'))]])
    expect(f.doneWrites).toEqual([['run-one']])
})

test('Quit after opening confirmation blocks its retained pending and Done mutations', async () => {
    const f = fixture(), h = await mount({ open: true })
    await click(markAll(h.container))
    const confirm = captured.confirm!
    await act(async () => { await flushDesktopDrafts() })
    await act(async () => { confirm() })
    expect(f.pendingWrites).toEqual([]); expect(f.doneWrites).toEqual([])
})

// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { DesktopPendingInboxItem } from '@/lib/desktop/pending-inbox'
import { DesktopNeedsChats } from './DesktopNeedsChats'
import { DesktopLocale } from './DesktopLocale'
import { loadMessages } from '@rerun/i18n/messages'
import { desktopMessages } from '@/lib/desktop/locale'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const now = '2026-11-04T12:00:00Z'
const item = (id: string, agentId = 'alice'): DesktopPendingInboxItem => ({ id, agentId, agentName: agentId, agentEnabled: true,
    kind: 'approval', sessionId: `chat-${id}`, title: `Request ${id}`, summary: `Review ${id}`, requestedAt: now, updatedAt: now })
const roots = new Set<ReturnType<typeof createRoot>>()
beforeEach(() => { vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] }); vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible') })
afterEach(async () => { await act(async () => { for (const root of roots) root.unmount() }); roots.clear(); document.body.innerHTML = ''; vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers() })
const settle = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 30)) })
async function mount() {
    const root = createRoot(document.body.appendChild(document.createElement('div'))); roots.add(root)
    const select = vi.fn()
    await act(async () => { root.render(<DesktopNeedsChats agentId="alice" query="" onSelect={select} />) })
    await settle()
    return { root, select }
}
async function click(text: string, role = 'button', scope: ParentNode = document) {
    const element = [...scope.querySelectorAll<HTMLElement>(role === 'button' ? 'button, [role="button"]' : `[role="${role}"]`)].find(row => row.textContent?.trim().includes(text))
    expect(element, text).toBeTruthy()
    await act(async () => { element!.click() }); await settle()
}
function fixture(initial = [item('a'), item('other', 'bob')]) {
    let items = initial
    let fail = false
    const writes: unknown[] = []
    const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
        if (url === '/api/desktop/pending-inbox/read') {
            const sent = JSON.parse(String(init?.body)).items as DesktopPendingInboxItem[]
            writes.push(sent); items = items.filter(row => !sent.some(target => target.id === row.id))
            return Response.json({ marked: sent.length, failedIds: [] })
        }
        if (url !== '/api/desktop/pending-inbox') throw new Error(`Unexpected mutation: ${url}`)
        return fail ? new Response('', { status: 503 }) : Response.json({ items, unavailableAgentIds: [], checkedAt: now })
    })
    vi.stubGlobal('fetch', fetcher)
    return { fetcher, writes, replace: (next: DesktopPendingInboxItem[]) => { items = next }, fail: () => { fail = true } }
}

test('scopes by coworker and freshly checks a pending row before navigating without answering', async () => {
    const api = fixture(); const { select } = await mount()
    expect(document.body.textContent).not.toContain('Request other')
    await click('Request a')
    expect(select).toHaveBeenCalledExactlyOnceWith('chat-a')
    expect(api.writes).toEqual([])
    expect(api.fetcher).toHaveBeenCalledTimes(2)
})

test('a replaced request is not opened and a failed read is not described as empty', async () => {
    const api = fixture(); const { select } = await mount()
    api.replace([item('replacement')])
    const row = document.querySelector<HTMLElement>('[role="button"]')!
    await act(async () => { row.click() }); await settle()
    expect(select).not.toHaveBeenCalled()
    expect(document.body.textContent).toContain('This request changed')
    api.fail()
    await click('Retry')
    expect(document.body.textContent).toContain('Pending requests could not be loaded')
    expect(document.body.textContent).not.toContain('Nothing waits on you')
})

test('bulk confirmation marks only its captured coworker rows and leaves a later arrival unread', async () => {
    const api = fixture(); await mount()
    await click('Mark all as read')
    expect(document.querySelector('[role="alertdialog"]')?.textContent).toContain('without being answered')
    api.replace([item('a'), item('later'), item('other', 'bob')])
    await act(async () => { vi.advanceTimersByTime(3000) }); await settle()
    await click('Mark all as read', 'button', document.querySelector('[role="alertdialog"]')!)
    expect(api.writes).toEqual([[{ id: 'a', agentId: 'alice', sessionId: 'chat-a', kind: 'approval' }]])
    expect(document.body.textContent).toContain('Request later')
    expect(document.body.textContent).not.toContain('Request a')
})

test('opening a confirmation cancels an earlier row check instead of letting it navigate late', async () => {
    const api = fixture(); const { select } = await mount()
    let finish!: (reply: Response) => void
    api.fetcher.mockImplementationOnce(async () => new Promise<Response>(resolve => { finish = resolve }))
    await click('Request a')
    await click('Mark all as read')
    await act(async () => { finish(Response.json({ items: [item('a')], unavailableAgentIds: [], checkedAt: now })) })
    expect(select).not.toHaveBeenCalled()
    expect(document.querySelector('[role="alertdialog"]')?.textContent).toContain('Mark everything as read?')
})

test('uses shared French inbox controls and does not clear anything when the confirmation is cancelled', async () => {
    const api = fixture([item('a')])
    const shared = await loadMessages('fr')
    const markAll = shared.agent.agentChatsList.markAllRead
    const root = createRoot(document.body.appendChild(document.createElement('div'))); roots.add(root)
    await act(async () => { root.render(<DesktopLocale initial={{ preference: 'fr', locale: 'fr', messages: desktopMessages('fr', shared) }}>
        <DesktopNeedsChats agentId="alice" query="" onSelect={() => {}} />
    </DesktopLocale>) })
    await settle()
    expect([...document.querySelectorAll('button')].map(button => button.getAttribute('aria-label'))).toContain(shared.kit.inbox.markRead)
    await click(markAll.confirm)
    const dialog = document.querySelector('[role="alertdialog"]')!
    expect(dialog.textContent).toContain(markAll.title)
    await click(shared.common.cancel, 'button', dialog)
    expect(api.writes).toEqual([])
    expect(document.body.textContent).toContain('Review a')
})

// @vitest-environment happy-dom
// Authored for the notifications lane; the integration owner runs all validation.
import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { DESKTOP_ATTENTION_URL, desktopAttentionSchema } from '@/lib/desktop/attention'
import { DESKTOP_COMPLETIONS_URL, desktopCompletionsSchema } from '@/lib/desktop/completed-actions'
import { DESKTOP_NOTIFICATION_EVENTS_URL, DESKTOP_NOTIFICATION_SEEN_URL } from '@/lib/desktop/notifications'
import { playNotificationSoundOnce } from '@/lib/notifications/browser'
import { DesktopNotificationDelivery } from './DesktopNotificationDelivery'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const playSound = vi.fn()
vi.mock('@/lib/notifications/browser', () => ({ playNotificationSoundOnce, playNotificationSound: vi.fn() }))

const roots: Root[] = []
const seenKeys: string[][] = []
const notifications: { key: string; kind: string; title: string; subtitle?: string; body?: string; silent?: boolean; agentId: string; sessionId: string | null; groupId?: string | null; requestId?: string | null }[] = []
let clickHandler: ((target: { key: string; kind: 'done' | 'question' | 'approval'; agentId: string; sessionId: string | null; groupId?: string | null; requestId?: string | null }) => void) | undefined
const queuedEvents: { events: unknown; channels?: { toast: boolean; sound: boolean } }[] = []
const attentionItems: { id: string; kind: 'question' | 'approval'; agentId: string; agentName: string; agentEnabled: boolean; sessionId: string; title: string; summary: string; requestedAt?: string; updatedAt: string }[] = []
const completionGroups: { id: string; agentId: string; agentName: string; agentEnabled: boolean; sessionId: string; sessionIds: string[]; title: string; message: string | null; source: 'chat'; slug: null; count: number; completedAt: string; completionIds: string[] }[] = []
const navigations: { agentId: string; sessionId: string; title: string }[] = []
let setVisibleExternally: (value: string | null) => void = () => {}

const questionEvent = (id: string) => ({
    key: `pending:${id}`, kind: 'question' as const, agentId: 'ada', agentName: 'Ada', sessionId: 's1',
    title: 'Ada', subtitle: 'Question', body: 'Which color should I use?', silent: false, requestId: id,
})
const approvalEvent = (id: string) => ({
    key: `pending:${id}`, kind: 'approval' as const, agentId: 'ada', agentName: 'Ada', sessionId: 's1',
    title: 'Ada', subtitle: 'Needs approval', body: 'Publish the draft', silent: false, requestId: id,
})
const doneEvent = (groupId: string) => ({
    key: `${groupId}:2100-01-01T00:00:01.000Z`, kind: 'done' as const, agentId: 'ada', agentName: 'Ada', sessionId: 's2',
    title: 'Ada', subtitle: 'Done', body: 'The draft is ready', silent: true, groupId,
})

beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
        const path = new URL(url, 'http://local').pathname
        if (path === DESKTOP_NOTIFICATION_EVENTS_URL) {
            const body = queuedEvents.splice(0, 1)[0] ?? { events: [], channels: { toast: true, sound: true } }
            return Response.json(body)
        }
        if (path === DESKTOP_NOTIFICATION_SEEN_URL) {
            const body = JSON.parse(String(init?.body)) as { keys: string[] }
            seenKeys.push(body.keys)
            return Response.json({ acknowledged: body.keys.length })
        }
        if (path === DESKTOP_ATTENTION_URL) return Response.json({ items: attentionItems, unavailableAgentIds: [], checkedAt: '' })
        if (path === DESKTOP_COMPLETIONS_URL) return Response.json({ items: completionGroups, unavailableAgentIds: [], enabledAt: '', nextCursor: null, checkedAt: '' })
        return Response.json({ error: 'Unexpected request' }, { status: 404 })
    }))
})

afterEach(async () => {
    await act(async () => { for (const root of roots.splice(0)) root.unmount() })
    document.body.innerHTML = ''
    ;(window as unknown as { desktopApp?: unknown }).desktopApp = undefined
    vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers()
    notifications.length = 0; seenKeys.length = 0; queuedEvents.length = 0
    attentionItems.length = 0; completionGroups.length = 0; navigations.length = 0
    clickHandler = undefined
})

function installBridge() {
    ;(window as unknown as { desktopApp?: unknown }).desktopApp = {
        notifications: {
            notify: (payload: { key: string; kind: string; title: string; subtitle?: string; body?: string; silent?: boolean; agentId: string; sessionId: string | null; groupId?: string | null; requestId?: string | null }) => notifications.push(payload),
            onNotificationClick: handler => { clickHandler = handler; return () => { if (clickHandler === handler) clickHandler = undefined } },
        },
    }
}

function render(initialVisible: string | null = null) {
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    roots.push(root)
    const mount = act(async () => {
        root.render(<Harness onOpen={target => { navigations.push(target) }} initialVisible={initialVisible} />)
    })
    return { mount }
}

function Harness({ onOpen, initialVisible = null }: { onOpen: (target: { agentId: string; sessionId: string; title: string }) => void; initialVisible?: string | null }) {
    const [visible, setVisible] = useState(initialVisible)
    setVisibleExternally = setVisible
    return <DesktopNotificationDelivery onOpenConversation={target => { setVisible(null); onOpen(target) }} visibleSessionId={visible} />
}

const advance = async (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms) })

test('a new pending question announces through the bridge with the original copy and is acknowledged once', async () => {
    installBridge()
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    queuedEvents.push({ events: [questionEvent('a'.repeat(64))], channels: { toast: true, sound: true } })
    await render()
    expect(notifications).toHaveLength(1)
    expect(notifications[0]).toMatchObject({ key: `pending:${'a'.repeat(64)}`, kind: 'question', title: 'Ada', subtitle: 'Question', body: 'Which color should I use?', silent: false, agentId: 'ada', sessionId: 's1', requestId: 'a'.repeat(64) })
    expect(playSound).toHaveBeenCalledWith(`pending:${'a'.repeat(64)}`)
    expect(seenKeys).toEqual([[`pending:${'a'.repeat(64)}`]])
    // The same key never announces twice, whatever the next poll brings.
    await advance(3000)
    expect(notifications).toHaveLength(1)
    expect(seenKeys).toHaveLength(1)
})

test('sound off silences the announcement but the toast still delivers and acknowledges', async () => {
    installBridge()
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    queuedEvents.push({ events: [questionEvent('b'.repeat(64))], channels: { toast: true, sound: false } })
    await render()
    expect(notifications).toHaveLength(1)
    expect(playSound).not.toHaveBeenCalled()
    expect(seenKeys).toEqual([[`pending:${'b'.repeat(64)}`]])
})

test('a done group announces silently with the finished-run copy and no sound', async () => {
    installBridge()
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    queuedEvents.push({ events: [doneEvent('done:ada:chat:s2')], channels: { toast: true, sound: true } })
    await render()
    expect(notifications).toHaveLength(1)
    expect(notifications[0]!.silent).toBe(true)
    expect(notifications[0]!.body).toBe('The draft is ready')
    expect(playSound).not.toHaveBeenCalled()
    expect(seenKeys).toEqual([['done:ada:chat:s2:2100-01-01T00:00:01.000Z']])
})

test('a question in the visible conversation stays in-app, then announces exactly once it can', async () => {
    installBridge()
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    queuedEvents.push({ events: [questionEvent('c'.repeat(64))], channels: { toast: true, sound: true } })
    await render('s1')
    expect(notifications).toHaveLength(0)
    expect(seenKeys).toHaveLength(0)
    // The chat is left: the same request announces exactly once and is acknowledged.
    await advance(3000)
    act(() => setVisibleExternally(null))
    await advance(3000)
    expect(notifications).toHaveLength(1)
    expect(seenKeys).toEqual([['pending:' + 'c'.repeat(64)]])
})

test('a click revalidates the exact pending request against the live projection before navigating', async () => {
    installBridge()
    attentionItems.push({ id: 'fresh', kind: 'question', agentId: 'ada', agentName: 'Ada', agentEnabled: true, sessionId: 's1', title: 'Chat', summary: 'Which color?', updatedAt: '' })
    await render()
    await act(async () => { clickHandler!({ key: 'pending:fresh', kind: 'question', agentId: 'ada', sessionId: 's1', requestId: 'fresh' }) })
    expect(navigations).toEqual([{ agentId: 'ada', sessionId: 's1', title: '' }])
    // The request was answered while the notification sat: a stale click lands nowhere.
    attentionItems.length = 0
    await act(async () => { clickHandler!({ key: 'pending:gone', kind: 'question', agentId: 'ada', sessionId: 's1', requestId: 'gone' }) })
    expect(navigations).toHaveLength(1)
})

test('a done click navigates to the group’s newest conversation only while the group still exists', async () => {
    installBridge()
    completionGroups.push({ id: 'done:ada:chat:s2', agentId: 'ada', agentName: 'Ada', agentEnabled: true, sessionId: 's9', sessionIds: ['s2', 's9'], title: 'Chat', message: null, source: 'chat', slug: null, count: 2, completedAt: '', completionIds: ['x', 'y'] })
    await render()
    await act(async () => { clickHandler!({ key: 'done:ada:chat:s2:2100-01-01T00:00:01.000Z', kind: 'done', agentId: 'ada', sessionId: 's2', groupId: 'done:ada:chat:s2' }) })
    expect(navigations).toEqual([{ agentId: 'ada', sessionId: 's9', title: '' }])
    completionGroups.length = 0
    await act(async () => { clickHandler!({ key: 'done:ada:chat:s2:2100-01-01T00:00:01.000Z', kind: 'done', agentId: 'ada', sessionId: 's2', groupId: 'done:ada:chat:s2' }) })
    expect(navigations).toHaveLength(1)
})

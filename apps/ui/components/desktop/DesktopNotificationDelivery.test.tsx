// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { DESKTOP_NOTIFICATION_EVENTS_URL, DESKTOP_NOTIFICATION_ADMIT_URL, DESKTOP_NOTIFICATION_DELIVERY_URL, DESKTOP_NOTIFICATION_TERMIALS_URL, type DesktopNotificationEvent } from '@/lib/desktop/notifications'
import type { DesktopNotificationTarget } from '@/lib/desktop/notification-bridge'
import { DESKTOP_ATTENTION_URL } from '@/lib/desktop/attention'
import { DESKTOP_COMPLETIONS_URL } from '@/lib/desktop/completed-actions'
import { DesktopNotificationDelivery } from './DesktopNotificationDelivery'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let root: Root | undefined
const events: DesktopNotificationEvent[] = []
const attempts = new Map<string, string>()
const delivered = new Set<string>()
const receipts: { key: string; attemptId: string; status: string }[] = []
const navigate = vi.fn(), notify = vi.fn(), audioPlay = vi.fn()
const toastTargets = new Map<string, (target: DesktopNotificationTarget) => void>()
vi.mock('@/lib/desktop/notification-toast', () => ({ showDesktopNotificationToast: (event: DesktopNotificationEvent, open: (target: DesktopNotificationTarget) => void) => { toastTargets.set(event.key, open) } }))
let listener: ((target: DesktopNotificationTarget) => void) | undefined
let channels = { toast: true, sound: false }, receiptFails = false
let attention: unknown[] = [], groups: unknown[] = [], terminal: unknown = null
let attentionRead: (() => Promise<Response>) | undefined
const event = (key = 'pending:request-a', sessionId = 'chat-a'): DesktopNotificationEvent => ({ key, kind: 'question', source: 'chat', agentId: 'agent-a', agentName: 'Ada', sessionId, title: 'Ada', subtitle: 'Question', body: 'Choose a color', silent: false, requestId: key.slice(8) })

beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    channels = { toast: true, sound: false }; receiptFails = false; attentionRead = undefined; toastTargets.clear()
    notify.mockReset().mockResolvedValue({ status: 'shown' }); audioPlay.mockReset().mockResolvedValue(undefined); navigate.mockReset()
    vi.stubGlobal('Audio', class { play = audioPlay; pause() {} })
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
    ;(window as unknown as { desktopApp: unknown }).desktopApp = { notifications: {
        notify, onNotificationClick: (callback: typeof listener) => { listener = callback; return () => { listener = undefined } },
    } }
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
        if (url === DESKTOP_NOTIFICATION_EVENTS_URL) return Response.json({ events: events.filter(row => !attempts.has(row.key) && !delivered.has(row.key)), channels, unavailableAgentIds: [], checkedAt: '' })
        if (url === DESKTOP_NOTIFICATION_ADMIT_URL) {
            const keys = JSON.parse(String(init?.body)).keys as string[]
            const rows = events.filter(row => keys.includes(row.key) && !attempts.has(row.key) && !delivered.has(row.key)).map(row => {
                const attemptId = crypto.randomUUID(); attempts.set(row.key, attemptId); return { ...row, attemptId }
            })
            return Response.json({ events: rows, channels })
        }
        if (url === DESKTOP_NOTIFICATION_DELIVERY_URL) {
            if (receiptFails) return Response.json({ error: 'lost' }, { status: 503 })
            const receipt = JSON.parse(String(init?.body)); receipts.push(receipt)
            if (attempts.get(receipt.key) === receipt.attemptId && receipt.status !== 'unknown') {
                attempts.delete(receipt.key)
                if (receipt.status === 'shown') delivered.add(receipt.key)
            }
            return Response.json({ recorded: true })
        }
        if (url === DESKTOP_ATTENTION_URL) return attentionRead ? attentionRead() : Response.json({ items: attention, unavailableAgentIds: [], checkedAt: '' })
        if (url === DESKTOP_COMPLETIONS_URL) return Response.json({ items: groups, unavailableAgentIds: [], checkedAt: '', enabledAt: '', nextCursor: null })
        if (String(url).startsWith(DESKTOP_NOTIFICATION_TERMIALS_URL)) return Response.json(terminal)
        throw new Error(`Unexpected request ${url}`)
    }))
})
afterEach(async () => {
    if (root) await act(async () => root?.unmount())
    root = undefined; events.length = 0; attempts.clear(); delivered.clear(); receipts.length = 0; attention = []; groups = []; terminal = null; listener = undefined
    document.body.innerHTML = ''; (window as unknown as { desktopApp?: unknown }).desktopApp = undefined
    vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers()
})
async function mount(visibleSessionId: string | null = null) {
    const container = document.createElement('div'); document.body.append(container); root = createRoot(container)
    await act(async () => { root?.render(<DesktopNotificationDelivery visibleSessionId={visibleSessionId} onOpenConversation={navigate} />) })
}
const tick = async () => act(async () => { await vi.advanceTimersByTimeAsync(3000) })
const pendingItem = (row: DesktopNotificationEvent) => ({ id: row.requestId, kind: row.kind, agentId: row.agentId, agentName: row.agentName, agentEnabled: true, sessionId: row.sessionId, title: '', summary: '', updatedAt: '' })

test('durable admission precedes native delivery and a lost receipt does not replay after remount', async () => {
    events.push(event()); receiptFails = true
    notify.mockImplementation(async () => { expect(attempts.has(events[0]!.key)).toBe(true); return { status: 'shown' } })
    await mount(); expect(notify).toHaveBeenCalledTimes(1)
    await act(async () => root?.unmount()); root = undefined
    receiptFails = false; await mount(); await tick()
    expect(notify).toHaveBeenCalledTimes(1)
    expect(attempts.size).toBe(1)
})
test('a missing bridge still delivers the in-app toast while disabled channels never consume events', async () => {
    events.push(event()); (window as unknown as { desktopApp?: unknown }).desktopApp = undefined
    await mount(); expect(notify).not.toHaveBeenCalled(); expect(delivered.has(events[0]!.key)).toBe(true)
    events.push(event('pending:request-b', 'chat-b')); channels = { toast: false, sound: false }; await tick()
    expect(receipts).toHaveLength(1); expect(receipts[0]!.status).toBe('shown'); expect(delivered.size).toBe(1)
})
test('a failed sound releases its exact admission and a later successful retry settles', async () => {
    channels = { toast: false, sound: true }; events.push(event())
    audioPlay.mockRejectedValueOnce(new Error('audio blocked'))
    await mount(); expect(notify).not.toHaveBeenCalled(); expect(attempts.size).toBe(0); expect(delivered.size).toBe(0)
    await tick(); expect(audioPlay).toHaveBeenCalledTimes(2); expect(delivered.has(events[0]!.key)).toBe(true)
    expect(receipts.map(row => row.status)).toEqual(['unavailable', 'shown'])
})
test('an ambiguous native outcome cannot unsend the in-app toast or replay it', async () => {
    events.push(event()); notify.mockRejectedValueOnce(new Error('IPC disconnected'))
    await mount(); await tick()
    expect(notify).toHaveBeenCalledTimes(1); expect(delivered.has(events[0]!.key)).toBe(true)
    expect(receipts.map(row => row.status)).toEqual(['shown'])
})
test('the original sound is a real acknowledged channel and never rings for Done', async () => {
    channels = { toast: false, sound: true }; events.push(event())
    await mount(); expect(audioPlay).toHaveBeenCalledTimes(1); expect(notify).not.toHaveBeenCalled()
    events.push({ ...event('done:completion'), kind: 'done', groupId: 'group-a', requestId: undefined, silent: true })
    await tick(); expect(audioPlay).toHaveBeenCalledTimes(1); expect(delivered.size).toBe(1)
})
test('an open chat suppresses visible alerts but a hidden Mac window still receives them', async () => {
    events.push(event()); await mount('chat-a'); expect(notify).not.toHaveBeenCalled()
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
    await tick(); expect(notify).toHaveBeenCalledTimes(1)
})
test('terminal clicks reject a rebound owner or conversation', async () => {
    await mount(); terminal = { agentId: 'another-owner', sessionId: 'another-chat' }
    await act(async () => listener?.({ key: 'terminal:run-a', kind: 'error', agentId: 'agent-a', sessionId: 'chat-a', terminalId: 'run-a' }))
    expect(navigate).not.toHaveBeenCalled()
})
test('a folded completion click keeps its original chat and rejects a removed member', async () => {
    await mount()
    const group = { id: 'group-a', agentId: 'agent-a', agentName: 'Ada', agentEnabled: true, sessionId: 'newer-chat',
        sessionIds: ['newer-chat', 'chat-a'], title: 'Morning', message: null, source: 'schedule', slug: 'morning',
        count: 2, completedAt: '', completionIds: ['newer-run', 'clicked-run'] }
    groups = [group]
    const target: DesktopNotificationTarget = { key: 'done:clicked-run', kind: 'done', agentId: 'agent-a', sessionId: 'chat-a', groupId: 'group-a' }
    await act(async () => listener?.(target))
    expect(navigate).toHaveBeenLastCalledWith({ agentId: 'agent-a', sessionId: 'chat-a', title: '' })
    groups = [{ ...group, sessionIds: ['newer-chat'], count: 1, completionIds: ['newer-run'] }]
    await act(async () => listener?.(target))
    expect(navigate).toHaveBeenCalledTimes(1)
})
test('superseded and unmounted click reads cannot navigate late', async () => {
    await mount()
    const a = event(), b = event('pending:request-b', 'chat-b')
    let release!: (value: Response) => void
    attentionRead = () => new Promise(resolve => { release = resolve })
    await act(async () => listener?.(a))
    attentionRead = undefined; attention = [pendingItem(b)]
    await act(async () => listener?.(b))
    await act(async () => release(Response.json({ items: [pendingItem(a)], unavailableAgentIds: [], checkedAt: '' })))
    expect(navigate).toHaveBeenCalledTimes(1); expect(navigate).toHaveBeenLastCalledWith({ agentId: 'agent-a', sessionId: 'chat-b', title: '' })
    attentionRead = () => new Promise(resolve => { release = resolve })
    await act(async () => listener?.(a)); await act(async () => root?.unmount()); root = undefined
    await act(async () => release(Response.json({ items: [pendingItem(a)], unavailableAgentIds: [], checkedAt: '' })))
    expect(navigate).toHaveBeenCalledTimes(1)
})

test('toast and native clicks share supersession, unmount and exact target checks', async () => {
    const a = event(), b = event('pending:request-b', 'chat-b')
    events.push(a, b)
    await mount()
    let release!: (response: Response) => void
    attentionRead = () => new Promise(resolve => { release = resolve })
    await act(async () => { toastTargets.get(a.key)?.(a) })
    attentionRead = undefined; attention = [pendingItem(b)]
    await act(async () => { listener?.(b) })
    await act(async () => { release(Response.json({ items: [pendingItem(a)], unavailableAgentIds: [], checkedAt: '' })) })
    expect(navigate).toHaveBeenCalledTimes(1)
    expect(navigate).toHaveBeenLastCalledWith({ agentId: 'agent-a', sessionId: 'chat-b', title: '' })
    const oldToast = toastTargets.get(a.key)!
    await act(async () => { root?.unmount(); root = undefined })
    attention = [pendingItem(a)]
    await act(async () => { oldToast(a) })
    expect(navigate).toHaveBeenCalledTimes(1)
})

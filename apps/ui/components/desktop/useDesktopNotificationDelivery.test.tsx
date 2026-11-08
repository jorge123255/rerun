// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, test, vi } from 'vitest'
import { useDesktopNotificationDelivery } from './useDesktopNotificationDelivery'

const toast = vi.hoisted(() => vi.fn())
vi.mock('@/lib/desktop/notification-toast', () => ({ showDesktopNotificationToast: toast }))

afterEach(() => {
    vi.unstubAllGlobals()
    Reflect.deleteProperty(window, 'desktopApp')
    toast.mockClear()
})

test.each(['failed', 'unknown', 'unavailable', 'shown'] as const)('receipts preserve the native %s result after an in-app toast', async nativeStatus => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    const event = {
        key: 'completion:fixture', attemptId: '11111111-1111-4111-8111-111111111111',
        kind: 'done', source: 'schedule', agentId: 'fixture-agent', agentName: 'Fixture',
        sessionId: 'fixture-session', title: 'Fixture', subtitle: 'Done', body: null, silent: true,
    }
    const channels = { toast: true, sound: false }
    const notify = vi.fn(async () => ({ status: nativeStatus }))
    Object.assign(window, { desktopApp: { notifications: { notify } } })
    const fetch = vi.fn(async (url: string, _init?: RequestInit) => {
        if (url.endsWith('/events')) return Response.json({ events: [event], channels, unavailableAgentIds: [], checkedAt: 'fixture' })
        if (url.endsWith('/admit')) return Response.json({ events: [event], channels })
        return Response.json({ recorded: true })
    })
    vi.stubGlobal('fetch', fetch)
    function Delivery() { useDesktopNotificationDelivery(); return null }
    const root = createRoot(document.createElement('div'))
    try {
        await act(async () => { root.render(<Delivery />) })
        expect(toast).toHaveBeenCalledTimes(1)
        expect(notify).toHaveBeenCalledTimes(1)
        const receipt = fetch.mock.calls.find(([url]) => url.endsWith('/delivery'))
        expect(JSON.parse(String(receipt?.[1]?.body))).toEqual({
            key: event.key, attemptId: event.attemptId, status: 'shown', nativeStatus,
        })
    } finally { await act(async () => { root.unmount() }) }
})

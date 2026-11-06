import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { deliverDesktopUserNotification } from './delivery'

beforeEach(() => {
    process.env.RERUN_HUB_BASE_URL = 'http://127.0.0.1:43110'
    process.env.RERUN_API_KEY = 'test-key'
})
afterEach(() => vi.unstubAllGlobals())
const receipt = { notificationId: 'notify-a', eventKey: 'notify-k', attemptId: '11111111-1111-4111-8111-111111111111', agentId: 'a', sessionId: 's', runId: 'r', message: 'm', metadata: null, status: 'unknown' as const, nativeStatus: 'unknown' as const, createdAt: '2026-11-06T00:00:00.000Z' }

test('posts to the authenticated loopback and returns the validated receipt', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify(receipt), { status: 200, headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal('fetch', fetcher)
    expect(await deliverDesktopUserNotification(receipt, new AbortController().signal)).toEqual(receipt)
    const [url, init] = fetcher.mock.calls[0]!
    expect(String(url)).toBe('http://127.0.0.1:43110/api/desktop/engine/notify-user')
    expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer test-key')
})

test('an invalid acknowledgement or transport failure is unknown, never shown and never retried', async () => {
    vi.stubGlobal('fetch', vi.fn()
        .mockResolvedValueOnce(new Response(JSON.stringify({ ...receipt, status: 'delivered' }), { status: 200 }))
        .mockRejectedValueOnce(new TypeError('offline')))
    await expect(deliverDesktopUserNotification(receipt, new AbortController().signal)).rejects.toMatchObject({ status: 'unknown' })
    await expect(deliverDesktopUserNotification(receipt, new AbortController().signal)).rejects.toMatchObject({ status: 'unknown' })
    expect(fetch).toHaveBeenCalledTimes(2)
})

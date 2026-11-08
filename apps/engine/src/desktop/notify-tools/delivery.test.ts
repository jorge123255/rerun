import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { clearCachedEnvForTests } from '../../config/env.js'
import type { DesktopNotifyUserAdmission } from './contract.js'
import { deliverDesktopUserNotification } from './delivery'

beforeEach(() => {
    vi.stubEnv('RERUN_HUB_BASE_URL', 'http://127.0.0.1:43110')
    vi.stubEnv('RERUN_API_KEY', 'test-key')
    clearCachedEnvForTests()
})
afterEach(() => {
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
    clearCachedEnvForTests()
})
const admission: DesktopNotifyUserAdmission = {
    notificationId: 'notify:a:s:r:c', eventKey: 'notify-user:a:s:r:c', agentId: 'a', agentName: 'Ada', sessionId: 's', runId: 'r', message: 'm', metadata: null,
}
const { agentName: _agentName, ...receiptIdentity } = admission
const receipt = { ...receiptIdentity, attemptId: '11111111-1111-4111-8111-111111111111', status: 'unknown' as const, nativeStatus: 'unknown' as const, createdAt: '2026-11-06T00:00:00.000Z' }

test('posts to the authenticated loopback and returns the validated receipt', async () => {
    const fetcher = vi.fn(async (_url: string, _init: RequestInit) => new Response(JSON.stringify(receipt), { status: 200, headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal('fetch', fetcher)
    expect(await deliverDesktopUserNotification(admission, new AbortController().signal)).toEqual(receipt)
    const [url, init] = fetcher.mock.calls[0]!
    expect(String(url)).toBe('http://127.0.0.1:43110/api/desktop/engine/notify-user')
    expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer test-key')
})

test('an invalid acknowledgement or transport failure is unknown, never shown and never retried', async () => {
    vi.stubGlobal('fetch', vi.fn()
        .mockResolvedValueOnce(new Response(JSON.stringify({ ...receipt, status: 'delivered' }), { status: 200 }))
        .mockRejectedValueOnce(new TypeError('offline')))
    await expect(deliverDesktopUserNotification(admission, new AbortController().signal)).rejects.toMatchObject({ status: 'unknown' })
    await expect(deliverDesktopUserNotification(admission, new AbortController().signal)).rejects.toMatchObject({ status: 'unknown' })
    expect(fetch).toHaveBeenCalledTimes(2)
})

const shown = { ...receipt, status: 'shown', nativeStatus: 'shown' }

test.each([
    shown,
    { ...receipt, status: 'failed', nativeStatus: 'unavailable' },
])('returns an exact $status acknowledgement from the delivery fixture', async acknowledgement => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(acknowledgement)))
    expect(await deliverDesktopUserNotification(admission, new AbortController().signal)).toEqual(acknowledgement)
    expect(fetch).toHaveBeenCalledTimes(1)
})

test('reports missing loopback configuration as unknown without contacting a destination', async () => {
    vi.stubEnv('RERUN_HUB_BASE_URL', undefined)
    clearCachedEnvForTests()
    const fetcher = vi.fn()
    vi.stubGlobal('fetch', fetcher)
    await expect(deliverDesktopUserNotification(admission, new AbortController().signal)).rejects.toMatchObject({ status: 'unknown' })
    expect(fetcher).not.toHaveBeenCalled()
})

test.each([
    { label: 'non-success HTTP status', httpStatus: 403, patch: {} },
    { label: 'notification ID', patch: { notificationId: 'notify:a:s:r:other' } },
    { label: 'event key', patch: { eventKey: 'notify-user:a:s:r:other' } },
    { label: 'coworker', patch: { agentId: 'other' } },
    { label: 'conversation', patch: { sessionId: 'other' } },
    { label: 'run', patch: { runId: 'other' } },
    { label: 'message', patch: { message: 'Earlier message' } },
    { label: 'native result', patch: { nativeStatus: 'unknown' } },
    { label: 'delivery result', patch: { status: 'unknown' } },
])('refuses a shown receipt with a mismatched $label without replay', async ({ httpStatus = 200, patch }) => {
    const fetcher = vi.fn(async () => Response.json({ ...shown, ...patch }, { status: httpStatus }))
    vi.stubGlobal('fetch', fetcher)
    await expect(deliverDesktopUserNotification(admission, new AbortController().signal)).rejects.toMatchObject({ status: 'unknown' })
    expect(fetcher).toHaveBeenCalledTimes(1)
})

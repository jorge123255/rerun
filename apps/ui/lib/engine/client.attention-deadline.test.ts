import { afterEach, expect, test, vi } from 'vitest'
import { getSessionMessages, listRuns } from './client'

const connection = { baseUrl: 'http://127.0.0.1:3299', apiKey: 'fixture-only' }
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

test('message and run reads forward the supplied whole-scan signal and settle on cancellation', async () => {
    const controller = new AbortController()
    const fetcher = vi.fn((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
        expect(init.signal).toBe(controller.signal)
        controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true })
    }))
    vi.stubGlobal('fetch', fetcher)
    const reads = [getSessionMessages(connection, 'alice', 'chat', { requireSuccess: true, signal: controller.signal }),
        listRuns(connection, 'alice', { status: 'running', limit: 1 }, { signal: controller.signal })]
    const reason = new DOMException('Whole-scan deadline', 'TimeoutError')
    controller.abort(reason)
    expect(await Promise.allSettled(reads)).toEqual([{ status: 'rejected', reason }, { status: 'rejected', reason }])
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(fetcher.mock.calls.map(call => call[0])).toEqual([
        connection.baseUrl + '/agents/alice/sessions/chat/messages', connection.baseUrl + '/agents/alice/runs?limit=1&status=running',
    ])
})

test('existing callers without a signal retain their default ten-second request timeout', async () => {
    const controller = new AbortController()
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal)
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
        expect(init.signal).toBe(controller.signal)
        return Response.json(url.endsWith('/messages') ? { messages: [] } : { runs: [] })
    }))
    expect(await getSessionMessages(connection, 'alice', 'chat')).toEqual([])
    expect(await listRuns(connection, 'alice')).toEqual([])
    expect(timeout.mock.calls).toEqual([[10_000], [10_000]])
})

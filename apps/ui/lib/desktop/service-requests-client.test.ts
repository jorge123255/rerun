import { afterEach, expect, test, vi } from 'vitest'
import type { DesktopServiceRequestMutation } from '@rerun/contracts'
import { createDesktopServiceRequestsClient } from './service-requests-client'
import { cardRevision, finishFixtureResponse, mutationRequestId, nextCardRevision, retryFixtureStorage, scope, serviceRequestFixture } from '@/components/desktop/service-requests/service-request-fixtures'

afterEach(() => vi.unstubAllGlobals())
const progress = (): DesktopServiceRequestMutation => ({ action: 'progress', requestId: mutationRequestId, serviceRequestId: scope.serviceRequestId,
    source: scope.source, expectedRevision: cardRevision, currentIndex: 0, choices: [{ slug: 'fixture', choice: 'skip' }] })

test('unknown progress retains the exact UUID, decision revision and choices after client restart', async () => {
    const storage = retryFixtureStorage()
    const sent: DesktopServiceRequestMutation[] = []
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => { sent.push(JSON.parse(String(init.body))); throw new Error('Lost response') }))
    const first = createDesktopServiceRequestsClient(scope, storage)
    await expect(first.mutate(progress())).rejects.toThrow('Lost response')
    first.dispose()
    const restarted = createDesktopServiceRequestsClient(scope, storage)
    expect(restarted.pending()).toEqual(progress())
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
        sent.push(JSON.parse(String(init.body)))
        return Response.json({ serviceRequestId: scope.serviceRequestId, revision: nextCardRevision, currentIndex: 0, choices: progress().choices })
    }))
    await restarted.mutate(restarted.pending()!)
    expect(sent[1]).toEqual(sent[0])
    expect(restarted.pending()).toBeNull()
    restarted.dispose()
})

test('rejects unknown or mismatched success bodies without losing the retry intent', async () => {
    const client = createDesktopServiceRequestsClient(scope, retryFixtureStorage())
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ status: 'unknown' })))
    await expect(client.mutate(progress())).rejects.toThrow()
    expect(client.pending()).toEqual(progress())
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ serviceRequestId: scope.serviceRequestId, revision: nextCardRevision, currentIndex: 0, choices: [{ slug: 'fixture', choice: 'pending' }] })))
    await expect(client.mutate(progress())).rejects.toThrow('did not match')
    expect(client.pending()).toEqual(progress())
    client.dispose()
})

test('never accepts another source or a late read from a disposed owner', async () => {
    const detail = serviceRequestFixture()
    detail.source.toolCallId = 'different-call'
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ request: detail })))
    const client = createDesktopServiceRequestsClient(scope, retryFixtureStorage())
    await expect(client.read()).rejects.toThrow('changed')
    let resolve!: (response: Response) => void
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(done => { resolve = done })))
    const read = client.read()
    const refusal = expect(read).rejects.toThrow()
    client.dispose()
    resolve(Response.json({ request: serviceRequestFixture() }))
    await refusal
})

test('only exact Finish headers acknowledge a follow-up; root owns cancellation after stream transfer', async () => {
    const client = createDesktopServiceRequestsClient(scope, retryFixtureStorage())
    const finish = { ...progress(), action: 'finish' as const }
    vi.stubGlobal('fetch', vi.fn(async () => finishFixtureResponse('40000000-0000-4000-8000-000000000001')))
    await expect(client.mutate(finish)).rejects.toThrow('did not match')
    expect(client.pending()).toEqual(finish)
    vi.stubGlobal('fetch', vi.fn(async () => finishFixtureResponse(mutationRequestId)))
    const result = await client.mutate(client.pending()!)
    expect(result.action).toBe('finish')
    if (result.action !== 'finish') throw new Error('Expected finish')
    expect(client.pending()).toBeNull()
    client.dispose()
    expect(result.signal.aborted).toBe(false)
    result.cancelStream()
    expect(result.signal.aborted).toBe(true)
    await result.response.body?.cancel()
})

test('reconstructs a server-sealed Finish after restart without submitting it on read', async () => {
    const detail = serviceRequestFixture()
    detail.choices = [{ slug: 'fixture', choice: 'skip' }]
    detail.retry = { phase: 'finishing', requestId: mutationRequestId }
    const fetcher = vi.fn(async () => Response.json({ request: detail }))
    vi.stubGlobal('fetch', fetcher)
    const client = createDesktopServiceRequestsClient(scope, retryFixtureStorage())
    const read = await client.read()
    expect(client.recoverFinish(read!)).toEqual({ ...progress(), action: 'finish' })
    expect(fetcher).toHaveBeenCalledOnce()
    client.dispose()
})

test('bounds streamed response bytes and refuses unavailable retry storage before POST', async () => {
    const client = createDesktopServiceRequestsClient(scope, retryFixtureStorage())
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array(2 * 1024 * 1024 + 1))))
    await expect(client.read()).rejects.toThrow('too large')
    client.dispose()
    const fetcher = vi.fn()
    vi.stubGlobal('fetch', fetcher)
    const blocked = createDesktopServiceRequestsClient(scope, { ...retryFixtureStorage(), setItem() { throw new Error('Storage unavailable') } })
    await expect(blocked.mutate(progress())).rejects.toThrow('Storage unavailable')
    expect(fetcher).not.toHaveBeenCalled()
    blocked.dispose()
})

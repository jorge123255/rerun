import { afterEach, expect, test, vi } from 'vitest'
import { createDesktopCoworkerCallsClient, DesktopCoworkerCallStopError, type DesktopCoworkerCallSnapshot } from '@/lib/desktop/coworker-calls-client'

const CALL_ID = '00000000-0000-4000-8000-000000000001'
const OTHER_CALL_ID = '00000000-0000-4000-8000-000000000002'
const snapshot = (patch: Partial<DesktopCoworkerCallSnapshot> = {}): DesktopCoworkerCallSnapshot => ({
    callId: CALL_ID, revision: '1', parentAgentId: 'parent-agent', parentSessionId: 'parent chat', parentRunId: 'parent-run', toolCallId: 'tool-call-1',
    targetAgentId: 'target-agent', targetSessionId: 'target-chat', targetName: 'Ada', wait: true, status: 'running',
    createdAt: '2026-11-05T10:00:00.000Z', updatedAt: '2026-11-05T10:01:00.000Z',
    progress: { steps: 2, toolCalls: 1, failures: 0, preview: '', calls: [] }, ...patch,
})

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

test('lists a strictly parsed empty or populated result for the exact parent', async () => {
    const owned = snapshot()
    const fetcher = vi.fn(async () => Response.json({ calls: [owned] }))
    vi.stubGlobal('fetch', fetcher)
    const client = createDesktopCoworkerCallsClient('parent-agent', 'parent chat')
    await expect(client.list()).resolves.toEqual([owned])
    expect(fetcher).toHaveBeenCalledWith('/api/desktop/sessions/parent%20chat/coworker-calls', expect.objectContaining({ method: 'GET', cache: 'no-store' }))
    client.dispose()
})

test.each([
    ['another owner', { calls: [snapshot({ parentAgentId: 'other' })] }],
    ['another chat', { calls: [snapshot({ parentSessionId: 'other' })] }],
    ['malformed snapshot', { calls: [{ callId: 'not-a-call' }] }],
    ['malformed envelope', { calls: null }],
])('rejects a read with %s instead of treating it as empty', async (_case, body) => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(body)))
    const client = createDesktopCoworkerCallsClient('parent-agent', 'parent chat')
    await expect(client.list()).rejects.toThrow()
    client.dispose()
})

test('Stop posts only the authorized call identity and reuses its request id after an unknown acknowledgement', async () => {
    const stopped = snapshot({ revision: '2', status: 'cancelled' })
    const fetcher = vi.fn()
        .mockResolvedValueOnce(Response.json({ error: 'Connection lost.' }, { status: 503 }))
        .mockResolvedValueOnce(Response.json({ call: stopped }))
    vi.stubGlobal('fetch', fetcher)
    const client = createDesktopCoworkerCallsClient('parent-agent', 'parent chat')
    await expect(client.stop(snapshot())).rejects.toThrow('Connection lost.')
    await expect(client.stop(snapshot())).resolves.toEqual(stopped)
    expect(fetcher).toHaveBeenCalledTimes(2)
    const first = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))
    const second = JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body))
    expect(first).toEqual({ operation: 'stop', requestId: expect.any(String), callId: CALL_ID, expectedRevision: '1' })
    expect(second).toEqual(first)
    expect(fetcher.mock.calls[0]?.[1]?.method).toBe('POST')
    client.dispose()
})

test('Stop preserves the authoritative call from a completion race', async () => {
    const settled = snapshot({ revision: '2', status: 'completed' })
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: 'This coworker call changed. Refresh it and try Stop again.', call: settled }, { status: 409 })))
    const client = createDesktopCoworkerCallsClient('parent-agent', 'parent chat')
    const failure = await client.stop(snapshot()).catch(error => error)
    expect(failure).toBeInstanceOf(DesktopCoworkerCallStopError)
    expect(failure.call).toEqual(settled)
    client.dispose()
})

test('Open chat re-reads ownership and uses only the fresh server-returned target', async () => {
    const current = snapshot({ revision: '2', targetSessionId: 'new-target-chat' })
    const fetcher = vi.fn(async (_url: string, _init?: RequestInit) => Response.json({ calls: [current] }))
    vi.stubGlobal('fetch', fetcher)
    const open = vi.fn(async () => {})
    const client = createDesktopCoworkerCallsClient('parent-agent', 'parent chat')
    await client.openTarget(snapshot(), open)
    expect(open).toHaveBeenCalledExactlyOnceWith({ agentId: 'target-agent', sessionId: 'new-target-chat' })
    expect(fetcher.mock.calls.every(call => call[1]?.method === 'GET')).toBe(true)
    client.dispose()
})

test('two same-name targets remain paired to their exact tool calls', async () => {
    const first = snapshot()
    const second = snapshot({ callId: OTHER_CALL_ID, toolCallId: 'tool-call-2', targetAgentId: 'target-b', targetSessionId: 'chat-b' })
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ calls: [first, second] })))
    const open = vi.fn(async () => {})
    const client = createDesktopCoworkerCallsClient('parent-agent', 'parent chat')
    await client.openTarget(second, open)
    expect(open).toHaveBeenCalledExactlyOnceWith({ agentId: 'target-b', sessionId: 'chat-b' })
    client.dispose()
})

test.each([
    ['missing', null],
    ['different run', snapshot({ parentRunId: 'replacement-run' })],
    ['different tool call', snapshot({ toolCallId: 'replacement-tool-call' })],
    ['different target', snapshot({ targetAgentId: 'replacement-agent' })],
    ['unassigned chat', snapshot({ targetSessionId: null })],
] as const)('Open chat refuses a %s fresh target without falling back', async (_case, current) => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ calls: current ? [current] : [] })))
    const open = vi.fn(async () => {})
    const client = createDesktopCoworkerCallsClient('parent-agent', 'parent chat')
    await expect(client.openTarget(snapshot(), open)).rejects.toThrow()
    expect(open).not.toHaveBeenCalled()
    client.dispose()
})

test('a disposed client aborts its read and cannot mutate a replacement owner', async () => {
    const fetcher = vi.fn(async (_url: string, init?: RequestInit) => {
        expect(init?.signal?.aborted).toBe(false)
        return Response.json({ calls: [] })
    })
    vi.stubGlobal('fetch', fetcher)
    const client = createDesktopCoworkerCallsClient('parent-agent', 'parent chat')
    client.dispose()
    await expect(client.list()).rejects.toThrow('owner changed')
    await expect(client.stop(snapshot())).rejects.toThrow('owner changed')
    expect(fetcher).not.toHaveBeenCalled()
})

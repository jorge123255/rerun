import { afterEach, expect, test, vi } from 'vitest'
import { createDesktopCoworkerCallsClient, type DesktopCoworkerCallSnapshot } from '@/lib/desktop/coworker-calls-client'

const snapshot = (patch: Partial<DesktopCoworkerCallSnapshot> = {}): DesktopCoworkerCallSnapshot => ({
    callId: 'call-1', revision: 'revision-1', parentAgentId: 'parent-agent', parentSessionId: 'parent chat', parentRunId: 'parent-run', toolCallId: 'tool-call-1',
    targetAgentId: 'target-agent', targetSessionId: 'target-chat', targetName: 'Ada', wait: true, status: 'running',
    createdAt: '2026-11-05T10:00:00.000Z', updatedAt: '2026-11-05T10:01:00.000Z',
    progress: { steps: 2, toolCalls: 1, failures: 0, preview: '', calls: [] }, ...patch,
})

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

test('lists only calls owned by the exact parent agent and chat', async () => {
    const owned = snapshot()
    const fetcher = vi.fn(async () => Response.json({ calls: [owned, snapshot({ callId: 'other-agent', parentAgentId: 'other' }), snapshot({ callId: 'other-chat', parentSessionId: 'other' })] }))
    vi.stubGlobal('fetch', fetcher)
    const client = createDesktopCoworkerCallsClient('parent-agent', 'parent chat')
    await expect(client.list()).resolves.toEqual([owned])
    expect(fetcher).toHaveBeenCalledWith('/api/desktop/sessions/parent%20chat/coworker-calls', expect.objectContaining({ method: 'GET', cache: 'no-store' }))
    client.dispose()
})

test('Stop posts only the authorized call identity and reuses its request id after an unknown acknowledgement', async () => {
    const stopped = snapshot({ revision: 'revision-2', status: 'cancelled' })
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
    expect(first).toEqual({ operation: 'stop', requestId: expect.any(String), callId: 'call-1', expectedRevision: 'revision-1' })
    expect(second).toEqual(first)
    expect(fetcher.mock.calls[0]?.[1]?.method).toBe('POST')
    client.dispose()
})

test('Open chat re-reads ownership and uses only the fresh server-returned target', async () => {
    const current = snapshot({ revision: 'revision-2', targetSessionId: 'new-target-chat' })
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ calls: [current] })))
    const open = vi.fn(async () => {})
    const client = createDesktopCoworkerCallsClient('parent-agent', 'parent chat')
    await client.openTarget(snapshot(), open)
    expect(open).toHaveBeenCalledExactlyOnceWith({ agentId: 'target-agent', sessionId: 'new-target-chat' })
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

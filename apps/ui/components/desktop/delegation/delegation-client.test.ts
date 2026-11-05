import { afterEach, expect, test, vi } from 'vitest'
import {
    DELEGATION_LIST_UNAVAILABLE,
    DELEGATION_STOP_UNAVAILABLE,
    createDesktopDelegationClient,
    readDelegationList,
    readDelegationSnapshot,
    visibleDelegations,
} from '@/lib/desktop/delegation-client'

const delegationId = '11111111-1111-4111-8111-111111111111'
const taskId = '22222222-2222-4222-8222-222222222222'
const otherTaskId = '33333333-3333-4333-8333-333333333333'
const revision = '44444444-4444-4444-8444-444444444444'
const nextRevision = '55555555-5555-4555-8555-555555555555'

function task(over: Record<string, unknown> = {}) {
    return {
        taskId, title: 'Write the notes', status: 'running', steps: 1, toolCalls: 1, failures: 0, preview: '',
        calls: [{ tool: 'web_search', summary: 'notes' }], cleanup: 'pending', ...over,
    }
}

function snapshot(over: Record<string, unknown> = {}) {
    return {
        delegationId, revision, parentAgentId: 'agent-a', parentSessionId: 'session-a', parentRunId: 'run-a',
        toolCallId: 'tool-a', tasks: [task()], ...over,
    }
}

afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
})

test('reads a durable snapshot without inventing timing or live events', () => {
    const parsed = readDelegationSnapshot(snapshot())
    expect(parsed.tasks[0]).not.toHaveProperty('idleMs')
    expect(parsed.tasks[0]).not.toHaveProperty('startedAt')
    expect(parsed.tasks[0]).not.toHaveProperty('finishedAt')
    expect(parsed.tasks[0]).not.toHaveProperty('activity')
    expect(parsed.tasks[0]!.calls[0]).not.toHaveProperty('elapsedMs')
    expect(parsed.tasks[0]!.calls[0]).not.toHaveProperty('durationMs')
    const kept = readDelegationSnapshot(snapshot({
        tasks: [task({ idleMs: 180_000, startedAt: 1_000, finishedAt: 2_500, calls: [{ tool: 'web_search', summary: 'notes', elapsedMs: 40 }] })],
    }))
    expect(kept.tasks[0]).toMatchObject({ idleMs: 180_000, startedAt: 1_000, finishedAt: 2_500 })
    expect(kept.tasks[0]!.calls[0]).toMatchObject({ elapsedMs: 40 })
})

test('rejects an unreadable list instead of returning a partial one', () => {
    expect(() => readDelegationList({ delegations: [snapshot(), snapshot({ tasks: [task({ status: 'later' })] })] })).toThrow(DELEGATION_LIST_UNAVAILABLE)
    expect(() => readDelegationList({ delegations: 'none' })).toThrow(DELEGATION_LIST_UNAVAILABLE)
})

test('keeps server order and drops other sessions and tool calls', () => {
    const rows = [
        snapshot({ toolCallId: 'tool-b', tasks: [task({ title: 'Second' })] }),
        snapshot({ delegationId: '66666666-6666-4666-8666-666666666666', tasks: [task({ title: 'First' })] }),
        snapshot({ parentSessionId: 'session-b' }),
    ]
    expect(visibleDelegations(rows as never, { sessionId: 'session-a', toolCallId: 'tool-a' }).map(item => item.tasks[0]!.title)).toEqual(['First'])
})

test('reuses one Stop request id until the revision changes', async () => {
    const ids = new Map<string, string>()
    const sent: unknown[] = []
    let status = 409
    vi.stubGlobal('fetch', async (_url: string, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as { requestId: string; expectedRevision: string }
        sent.push(body)
        if (status === 409) return Response.json({ error: DELEGATION_STOP_UNAVAILABLE }, { status: 409 })
        return Response.json({ delegation: snapshot({ revision: body.expectedRevision === revision ? nextRevision : body.expectedRevision, tasks: [task({ status: 'stopped', finishedAt: 2_000 })] }) })
    })
    const client = createDesktopDelegationClient(ids)
    const input = { delegationId, taskId, expectedRevision: revision }
    await expect(client.stop('session-a', input)).rejects.toThrow(DELEGATION_STOP_UNAVAILABLE)
    status = 200
    await client.stop('session-a', input)
    await client.stop('session-a', { ...input, expectedRevision: nextRevision })
    expect(sent).toHaveLength(3)
    expect(sent[0]).toEqual({ operation: 'stop-task', requestId: (sent[0] as { requestId: string }).requestId, delegationId, taskId, expectedRevision: revision })
    expect((sent[1] as { requestId: string }).requestId).toBe((sent[0] as { requestId: string }).requestId)
    expect((sent[2] as { requestId: string }).requestId).not.toBe((sent[0] as { requestId: string }).requestId)
    expect(Object.keys(sent[0] as object)).toEqual(['operation', 'requestId', 'delegationId', 'taskId', 'expectedRevision'])
})

test('a failed Stop does not invent a stopped task', async () => {
    vi.stubGlobal('fetch', async () => Response.json({ error: DELEGATION_STOP_UNAVAILABLE }, { status: 409 }))
    const client = createDesktopDelegationClient(new Map())
    await expect(client.stop('session-a', { delegationId, taskId, expectedRevision: revision })).rejects.toThrow(DELEGATION_STOP_UNAVAILABLE)
})

test('dispose aborts a list that is still reading', async () => {
    vi.stubGlobal('fetch', (_url: string, init?: RequestInit) => new Promise((_resolve, reject) => {
        const fail = () => {
            const error = new Error('aborted')
            error.name = 'AbortError'
            reject(error)
        }
        if (init?.signal?.aborted) fail()
        else init?.signal?.addEventListener('abort', fail, { once: true })
    }))
    const client = createDesktopDelegationClient(new Map())
    const pending = client.list('session-a')
    client.dispose()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
})

test('lists only the delegation route for that session', async () => {
    const urls: string[] = []
    vi.stubGlobal('fetch', async (url: string) => {
        urls.push(String(url))
        return Response.json({ delegations: [snapshot(), snapshot({ delegationId: '66666666-6666-4666-8666-666666666666', tasks: [task({ taskId: otherTaskId, title: 'Later' })] })] })
    })
    const rows = await createDesktopDelegationClient(new Map()).list('session/a')
    expect(urls).toEqual(['/api/desktop/sessions/session%2Fa/delegation'])
    expect(rows.map(item => item.tasks[0]!.title)).toEqual(['Write the notes', 'Later'])
})

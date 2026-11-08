import { createServer, type Server } from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { Message, RunDetail, Session } from '@rerun/contracts'
import { closeDesktopDatabase, openDesktopDatabase } from '@/lib/desktop/server/database'
import { createDesktopAgent, createDesktopSession, type DesktopAgent, type DesktopSession } from '@/lib/desktop/server/store'
import type { DesktopRuntime } from '@/lib/desktop/server/runtime'
import { GET as readPrefs, PUT as writePrefs } from './route'
import { GET as readEvents } from './events/route'
import { POST as acknowledge } from './seen/route'
import { POST as admit } from './admit/route'
import { POST as delivery } from './delivery/route'
import { GET as terminalBinding } from './terminals/[id]/route'
import { handleDesktopEngineCallback } from '@/lib/desktop/server/engine-callback'
import type { DesktopNotificationEvent } from '@/lib/desktop/notifications'
import type { CompletionRow } from '@/lib/desktop/completed-actions'

const originalEnv = { ...process.env }
let root: string, server: Server, runtime: DesktopRuntime
let alice: DesktopAgent, bob: DesktopAgent, aliceChat: DesktopSession, bobChat: DesktopSession
// Far past the install cutoff: the fixture runs finish well after this slice's first boot.
const raised = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString()
const histories = new Map<string, { owner: string; rows: Message[] }>(), completions: { owner: string; rows: Omit<CompletionRow, 'title'>[] }[] = []
const remoteSessions = new Map<string, Session>(), remoteRuns = new Map<string, RunDetail>()
const calls: string[] = []

function history(sessionId: string, createdAt: string): Message[] {
    return [
        { id: sessionId + '-request', sessionId, role: 'assistant', contentJson: JSON.stringify([{ type: 'tool-call', toolName: 'ask_user', toolCallId: sessionId + '-call', input: { questions: [{ question: 'Which color should I use?', options: ['Blue'] }] } }]), toolCallsJson: null, createdAt },
        { id: sessionId + '-result', sessionId, role: 'tool', contentJson: JSON.stringify([{ type: 'tool-result', toolName: 'ask_user', toolCallId: sessionId + '-call', output: { type: 'json', value: { status: 'delivered' } } }]), toolCallsJson: null, createdAt },
    ]
}
function prefsRequest(body: unknown) {
    return new Request(`${runtime.app.origin}/api/desktop/notifications`, {
        method: 'PUT', headers: { host: new URL(runtime.app.origin).host, origin: runtime.app.origin,
            cookie: `rerun-desktop-session=${runtime.app.sessionToken}`, 'content-type': 'application/json' }, body: JSON.stringify(body),
    })
}
const prefsGet = () => new Request(`${runtime.app.origin}/api/desktop/notifications`, { headers: { host: new URL(runtime.app.origin).host, origin: runtime.app.origin, cookie: `rerun-desktop-session=${runtime.app.sessionToken}` } })
const eventsGet = () => new Request(`${runtime.app.origin}/api/desktop/notifications/events`, { headers: { host: new URL(runtime.app.origin).host, origin: runtime.app.origin, cookie: `rerun-desktop-session=${runtime.app.sessionToken}`, 'sec-fetch-site': 'same-origin' } })
const seenPost = (keys: string[]) => new Request(`${runtime.app.origin}/api/desktop/notifications/seen`, {
    method: 'POST', headers: { host: new URL(runtime.app.origin).host, origin: runtime.app.origin,
        cookie: `rerun-desktop-session=${runtime.app.sessionToken}`, 'content-type': 'application/json' }, body: JSON.stringify({ keys }),
})
const terminalGet = (id: string) => new Request(`${runtime.app.origin}/api/desktop/notifications/terminals/${encodeURIComponent(id)}`, { headers: { host: new URL(runtime.app.origin).host, origin: runtime.app.origin, cookie: `rerun-desktop-session=${runtime.app.sessionToken}`, 'sec-fetch-site': 'same-origin' } })
const notificationPost = (path: string, body: unknown) => new Request(`${runtime.app.origin}/api/desktop/notifications/${path}`, {
    method: 'POST', headers: { host: new URL(runtime.app.origin).host, origin: runtime.app.origin,
        cookie: `rerun-desktop-session=${runtime.app.sessionToken}`, 'content-type': 'application/json' }, body: JSON.stringify(body),
})
const terminalId = (runId: string, agent = alice, session = aliceChat) => `${agent.id}:${session.id}:${runId}`
const enginePost = (payload: unknown) => handleDesktopEngineCallback(new Request(`${runtime.app.origin}/api/webhooks/engine`, {
    method: 'POST', headers: { host: new URL(runtime.app.origin).host, authorization: `Bearer ${runtime.engine.apiKey}`, 'content-type': 'application/json' }, body: JSON.stringify(payload),
}))
const terminalPayload = (over: Record<string, unknown>) => ({
    event: 'agent.message.completed', kind: 'done', agentId: alice.engineAgentId, sessionId: aliceChat.engineSessionId,
    runId: crypto.randomUUID(), message: 'Message completed', metadata: { status: 'done', source: 'chat' }, timestamp: raised(30_000), ...over,
})
function scheduledTerminal(runId: string, slug = 'morning-digest') {
    const timestamp = raised(70_000)
    remoteSessions.set(bobChat.engineSessionId, { id: bobChat.engineSessionId, agentId: bob.engineAgentId, title: bobChat.title,
        status: 'open', source: 'schedule', originAgentId: null, originSessionId: null, createdAt: bobChat.createdAt, updatedAt: timestamp })
    remoteRuns.set(runId, { id: runId, agentId: bob.engineAgentId, sessionId: bobChat.engineSessionId, status: 'error',
        stepCount: 1, usageJson: null, provider: 'codex', model: 'fixture', triggerSource: 'schedule', triggerSlug: slug,
        costMicros: null, inputTokens: null, outputTokens: null, cachedInputTokens: null, reasoningTokens: null, totalTokens: null,
        startedAt: raised(60_000), finishedAt: timestamp, error: 'timeout', output: null })
    return terminalPayload({ event: 'agent.schedule.completed', kind: 'error', agentId: bob.engineAgentId, sessionId: bobChat.engineSessionId,
        runId, message: `Schedule "${slug}" failed: timeout`, metadata: { status: 'error', source: 'schedule', scheduleSlug: slug }, timestamp })
}

beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'rerun-notifications-'))
    histories.clear(); remoteSessions.clear(); remoteRuns.clear(); completions.length = 0; calls.length = 0
    server = createServer((req, res) => {
        const url = new URL(req.url ?? 'http://fixture', 'http://fixture'); calls.push(`${req.method} ${url.pathname}`)
        const messages = url.pathname.match(/^\/agents\/([^/]+)\/sessions\/([^/]+)\/messages$/)
        if (req.method === 'GET' && messages) {
            const found = histories.get(messages[2]!)
            return res.writeHead(found?.owner === messages[1] ? 200 : 404, { 'content-type': 'application/json' }).end(JSON.stringify(found?.owner === messages[1] ? { messages: found.rows } : { error: 'Not found' }))
        }
        const completionsRoute = url.pathname.match(/^\/agents\/([^/]+)\/runs\/completions$/)
        if (req.method === 'GET' && completionsRoute) {
            const rows = completions.filter(entry => entry.owner === completionsRoute[1]).flatMap(entry => entry.rows)
            return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ completions: rows }))
        }
        const sessionRoute = url.pathname.match(/^\/agents\/([^/]+)\/sessions\/([^/]+)$/)
        if (req.method === 'GET' && sessionRoute) {
            const found = remoteSessions.get(sessionRoute[2]!)
            const owned = found?.agentId === sessionRoute[1]
            return res.writeHead(owned ? 200 : 404, { 'content-type': 'application/json' }).end(JSON.stringify(owned ? found : { error: 'Not found' }))
        }
        const runRoute = url.pathname.match(/^\/agents\/([^/]+)\/runs\/([^/]+)$/)
        if (req.method === 'GET' && runRoute) {
            const found = remoteRuns.get(runRoute[2]!)
            const owned = found?.agentId === runRoute[1]
            return res.writeHead(owned ? 200 : 404, { 'content-type': 'application/json' }).end(JSON.stringify(owned ? found : { error: 'Not found' }))
        }
        return res.writeHead(404).end(JSON.stringify({ error: 'Unexpected fixture request' }))
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing fixture address')
    runtime = { protocolVersion: 1, launchNonce: crypto.randomUUID(), buildId: 'notifications-api', workspaceId: 1, dataRoot: root,
        app: { origin: 'http://127.0.0.1:3199', sessionToken: 'n'.repeat(48) }, engine: { origin: `http://127.0.0.1:${address.port}`, apiKey: 'fixture-only' } }
    Object.assign(process.env, { RERUN_DESKTOP_APP: '1', RERUN_DESKTOP_DATA_DIR: root, RERUN_DESKTOP_RUNTIME_FILE: join(root, 'runtime.json') })
    await writeFile(join(root, 'runtime.json'), JSON.stringify(runtime), { mode: 0o600 })
    const db = await openDesktopDatabase(root)
    alice = await createDesktopAgent(db, { name: 'Alice', engineAgentId: 'engine-alice' })
    bob = await createDesktopAgent(db, { name: 'Bob', engineAgentId: 'engine-bob' })
    aliceChat = await createDesktopSession(db, { agentId: alice.id, engineSessionId: 'alice-ask', title: 'Chat with a question' })
    bobChat = await createDesktopSession(db, { agentId: bob.id, engineSessionId: 'bob-ask', title: 'Bob asks' })
    histories.set('alice-ask', { owner: alice.engineAgentId, rows: history('alice-ask', raised(90_000)) })
    histories.set('bob-ask', { owner: bob.engineAgentId, rows: history('bob-ask', raised(90_000)) })
})

afterEach(async () => {
    vi.restoreAllMocks()
    await closeDesktopDatabase(root)
    process.env = { ...originalEnv }
    await rm(root, { recursive: true, force: true })
    server.closeAllConnections?.(); server.close()
})

test('GET returns the recommended defaults and PUT merges the patch as the authoritative value', async () => {
    expect(await (await readPrefs(prefsGet())).json()).toEqual({
        version: 2, scope: 'mine', toast: true, sound: true, email: true, coworkers: {}, tasks: {}, categories: { billing: true, product: true },
    })
    const saved = await writePrefs(prefsRequest({ scope: 'everything', toast: false, coworkers: { [alice.id]: { mode: 'muted' } } }))
    expect(saved.status).toBe(200)
    expect(await saved.json()).toEqual({
        version: 2, scope: 'everything', toast: false, sound: true, email: true,
        coworkers: { [alice.id]: { mode: 'muted' } }, tasks: {}, categories: { billing: true, product: true },
    })
    expect((await (await readPrefs(prefsGet())).json()).coworkers[alice.id]).toEqual({ mode: 'muted' })
    expect((await writePrefs(prefsRequest({ scope: '  ' }))).status).toBe(400)
})

test('events follow the scope and coworker rules, and an acknowledged event never replays', async () => {
    // Alice is muted; Bob follows the default scope, so only Bob's pending question announces.
    await writePrefs(prefsRequest({ coworkers: { [alice.id]: { mode: 'muted' } } }))
    const first = await readEvents(eventsGet())
    const body = await first.json() as { events: DesktopNotificationEvent[]; channels: { toast: boolean; sound: boolean } }
    expect(body.channels).toEqual({ toast: true, sound: true })
    expect(body.events.map(event => [event.agentId, event.kind, event.subtitle])).toEqual([[bob.id, 'question', 'Question']])
    expect(body.events).toHaveLength(1)
    const bobEvent = body.events[0]!
    expect(bobEvent.agentId).toBe(bob.id)
    expect(bobEvent.body).toBe('Which color should I use?')
    expect(bobEvent.requestId).toBeTruthy()
    expect(bobEvent.silent).toBe(false)

    const acknowledged = await acknowledge(seenPost([bobEvent.key]))
    expect(acknowledged.status).toBe(200)
    await closeDesktopDatabase(root)
    const second = await (await readEvents(eventsGet())).json() as { events: unknown[] }
    expect(second.events).toEqual([])
})

test('done events follow the chat/schedule decision: started runs under mine, others stay quiet', async () => {
    completions.push({ owner: alice.engineAgentId, rows: [{ id: 'run-alice', runId: 'run-alice', agentId: alice.engineAgentId, sessionId: aliceChat.engineSessionId, source: 'chat', slug: null, completedAt: raised(90_000), text: 'The draft is ready', provider: 'codex', model: 'fixture', costMicros: null, stepCount: 2 }] })
    completions.push({ owner: bob.engineAgentId, rows: [{ id: 'run-bob', runId: 'run-bob', agentId: bob.engineAgentId, sessionId: bobChat.engineSessionId, source: 'schedule', slug: 'morning-digest', completedAt: raised(60_000), text: null, provider: 'codex', model: 'fixture', costMicros: null, stepCount: 1 }] })
    // Default scope « mine »: Alice's started run announces, Bob's unfollowed schedule stays quiet.
    const body = await (await readEvents(eventsGet())).json() as { events: { key: string; kind: string; agentId: string; subtitle: string; body: string | null; silent: boolean; groupId?: string }[] }
    const announced = body.events.filter(event => event.kind === 'done')
    expect(announced.map(event => event.agentId)).toEqual([alice.id])
    expect(announced[0]!.subtitle).toBe('Done')
    expect(announced[0]!.body).toBe('The draft is ready')
    expect(announced[0]!.silent).toBe(true)
    expect(announced[0]!.groupId).toBeTruthy()
    await acknowledge(seenPost(announced.map(event => event.key)))

    // A scheduled task with its own « notify me » switch announces under the same rules.
    await writePrefs(prefsRequest({ tasks: { [`${bob.id}:schedule:morning-digest`]: true } }))
    const after = await (await readEvents(eventsGet())).json() as { events: { kind: string; subtitle: string; agentId: string }[] }
    const scheduled = after.events.filter(event => event.kind === 'done')
    expect(scheduled.map(event => event.agentId)).toEqual([bob.id])
    expect(scheduled[0]!.subtitle).toBe('morning-digest · Done')
})

test('only explicit failed terminals announce as Failed; stopped and successful runs stay out of the failure ledger', async () => {
    const failed = terminalPayload({ kind: 'error', runId: 'run-failed', message: 'Message failed: provider timeout', metadata: { status: 'error', source: 'chat' } })
    const stopped = terminalPayload({ kind: 'done', runId: 'run-stopped', message: 'Message stopped', metadata: { status: 'cancelled', source: 'chat' } })
    const finished = terminalPayload({ kind: 'done', runId: 'run-done', metadata: { status: 'done', source: 'chat' } })
    expect((await enginePost(finished)).status).toBe(202)
    expect(await (await enginePost(finished)).json()).toMatchObject({ persisted: false })
    expect(await (await enginePost(failed)).json()).toMatchObject({ persisted: true })
    expect(await (await enginePost(stopped)).json()).toMatchObject({ persisted: false })
    expect(await (await enginePost(terminalPayload({ kind: 'error', metadata: { status: 'done', source: 'chat' } }))).json()).toMatchObject({ persisted: false })

    const body = await (await readEvents(eventsGet())).json() as { events: { key: string; kind: string; agentId: string; sessionId: string; subtitle: string; body: string | null; silent: boolean; terminalId?: string; groupId?: string }[] }
    const terminals = body.events.filter(event => event.terminalId)
    expect(terminals.map(event => event.terminalId)).toEqual([terminalId('run-failed')])
    const failedEvent = terminals[0]!
    // A failed run keeps the original urgent 'error' kind: it still announces under « needed ».
    expect(failedEvent).toMatchObject({ kind: 'error', agentId: alice.id, sessionId: aliceChat.id, subtitle: 'Failed', body: 'Message failed: provider timeout', silent: false })
    expect(failedEvent.key).toBe(`terminal:${terminalId('run-failed')}`)
    expect(failedEvent.groupId).toBeUndefined()

    const binding = await terminalBinding(terminalGet(terminalId('run-failed')), { params: Promise.resolve({ id: terminalId('run-failed') }) })
    expect(binding.status).toBe(200)
    expect(await binding.json()).toEqual({ agentId: alice.id, sessionId: aliceChat.id })
    expect((await terminalBinding(terminalGet('run-unknown'), { params: Promise.resolve({ id: 'run-unknown' }) })).status).toBe(404)

    // Acknowledged terminal keys never replay, exactly like completion and request keys.
    await acknowledge(seenPost(terminals.map(event => event.key)))
    await closeDesktopDatabase(root)
    expect((await (await readEvents(eventsGet())).json()).events.filter((event: DesktopNotificationEvent) => event.terminalId)).toEqual([])
})

test('a scheduled terminal gives the local owner the original follow, which then admits its done runs', async () => {
    // Bob's first scheduled terminal on an unruled coworker writes follow: true, like the hosted
    // owner-follow; his successful done stays on the completions store and announces under « mine ».
    completions.push({ owner: bob.engineAgentId, rows: [{ id: 'run-bob-done', runId: 'run-bob-done', agentId: bob.engineAgentId, sessionId: bobChat.engineSessionId, source: 'schedule', slug: 'morning-digest', completedAt: raised(80_000), text: null, provider: 'codex', model: 'fixture', costMicros: null, stepCount: 1 }] })
    const scheduled = scheduledTerminal('run-bob-failed')
    expect(await (await enginePost(scheduled)).json()).toMatchObject({ persisted: true })
    expect(calls).toContain(`GET /agents/${bob.engineAgentId}/sessions/${bobChat.engineSessionId}`)
    expect(calls).toContain(`GET /agents/${bob.engineAgentId}/runs/run-bob-failed`)

    const prefs = await (await readPrefs(prefsGet())).json() as { coworkers: Record<string, { mode: string; follow?: boolean }> }
    expect(prefs.coworkers[bob.id]).toEqual({ mode: 'default', follow: true })

    const body = await (await readEvents(eventsGet())).json() as { events: { kind: string; agentId: string; subtitle: string; terminalId?: string; groupId?: string }[] }
    const bobs = body.events.filter(event => event.agentId === bob.id && (event.kind === 'done' || event.kind === 'error'))
    // The failed terminal and the followed task's completion both announce, each with its own
    // revalidation identity: the recorded terminal and the finished-run group.
    expect(bobs).toHaveLength(2)
    expect(bobs.find(event => event.kind === 'done')?.subtitle).toBe('morning-digest · Done')
    expect(bobs.find(event => event.kind === 'error')?.subtitle).toBe('morning-digest · Failed')
    expect(bobs.filter(event => event.terminalId === terminalId('run-bob-failed', bob, bobChat))).toHaveLength(1)
    expect(bobs.filter(event => event.groupId)).toHaveLength(1)
})

test('scope « needed » keeps finished and stopped runs quiet while failures and questions still announce', async () => {
    await enginePost(terminalPayload({ kind: 'error', runId: 'run-needed', message: 'Message failed: boom', metadata: { status: 'error', source: 'chat' } }))
    await enginePost(terminalPayload({ kind: 'done', runId: 'run-stopped-needed', message: 'Message stopped', metadata: { status: 'cancelled', source: 'chat' } }))
    completions.push({ owner: alice.engineAgentId, rows: [{ id: 'run-alice', runId: 'run-alice', agentId: alice.engineAgentId, sessionId: aliceChat.engineSessionId, source: 'chat', slug: null, completedAt: raised(90_000), text: 'done', provider: 'codex', model: 'fixture', costMicros: null, stepCount: 1 }] })
    await writePrefs(prefsRequest({ scope: 'needed' }))
    const body = await (await readEvents(eventsGet())).json() as { events: { kind: string; subtitle: string; terminalId?: string }[] }
    // The original 'error' kind is urgent: a broken run still reaches under « needed », a stopped
    // or finished one does not.
    expect(body.events.filter(event => event.kind === 'done')).toEqual([])
    expect(body.events.filter(event => event.kind === 'error').map(event => event.terminalId)).toEqual([terminalId('run-needed')])
    expect(body.events.some(event => event.kind === 'question' && event.subtitle === 'Question')).toBe(true)
})

test('scope « nothing » and the install cutoff never announce, and nothing replayed after restart', async () => {
    await writePrefs(prefsRequest({ scope: 'nothing' }))
    expect((await (await readEvents(eventsGet())).json()).events).toEqual([])
    await writePrefs(prefsRequest({ scope: 'mine' }))
    const stale = await (await openDesktopDatabase(root)).execute('SELECT enabled_at FROM desktop_notifications_state WHERE id=1')
    expect(Date.parse(String(stale.rows[0]!.enabled_at))).toBeLessThan(Date.now())
    // A request raised before the slice's first boot is old history, never a new notification.
    histories.set('alice-ask', { owner: alice.engineAgentId, rows: history('alice-ask', '2020-01-01T00:00:00.000Z') })
    histories.set('bob-ask', { owner: bob.engineAgentId, rows: history('bob-ask', '2020-01-01T00:00:00.000Z') })
    expect((await (await readEvents(eventsGet())).json()).events).toEqual([])
    await closeDesktopDatabase(root)
    expect((await (await readEvents(eventsGet())).json()).events).toEqual([])
})

test('concurrent preference patches and automatic follow preserve independent choices', async () => {
    await Promise.all([
        writePrefs(prefsRequest({ toast: false })),
        writePrefs(prefsRequest({ sound: false })),
        writePrefs(prefsRequest({ coworkers: { [alice.id]: { mode: 'muted' } } })),
        enginePost(scheduledTerminal('run-bob-concurrent', 'morning')),
    ])
    expect(await (await readPrefs(prefsGet())).json()).toMatchObject({ toast: false, sound: false,
        coworkers: { [alice.id]: { mode: 'muted' }, [bob.id]: { mode: 'default', follow: true } } })
})

test('one durable admission wins concurrent polls and an ambiguous delivery remains suppressed after restart', async () => {
    const { events } = await (await readEvents(eventsGet())).json() as { events: DesktopNotificationEvent[] }
    const key = events[0]!.key
    const replies = await Promise.all([admit(notificationPost('admit', { keys: [key] })), admit(notificationPost('admit', { keys: [key] }))])
    const admitted = (await Promise.all(replies.map(reply => reply.json()))).flatMap(reply => reply.events) as (DesktopNotificationEvent & { attemptId: string })[]
    expect(admitted).toHaveLength(1)
    expect((await delivery(notificationPost('delivery', { key, attemptId: admitted[0]!.attemptId, status: 'unknown' }))).status).toBe(200)
    await closeDesktopDatabase(root)
    const reopened = await openDesktopDatabase(root)
    expect((await reopened.execute('SELECT * FROM desktop_notification_attempts')).rows).toHaveLength(1)
    expect((await reopened.execute('SELECT * FROM desktop_notifications_seen')).rows).toHaveLength(0)
    expect((await (await readEvents(eventsGet())).json()).events.some((event: DesktopNotificationEvent) => event.key === key)).toBe(false)
})

test('definite nondelivery retries with a fresh token and late old receipts cannot release that attempt', async () => {
    const { events } = await (await readEvents(eventsGet())).json() as { events: DesktopNotificationEvent[] }
    const key = events[0]!.key
    const first = (await (await admit(notificationPost('admit', { keys: [key] }))).json()).events[0] as { attemptId: string }
    await delivery(notificationPost('delivery', { key, attemptId: first.attemptId, status: 'unavailable' }))
    const second = (await (await admit(notificationPost('admit', { keys: [key] }))).json()).events[0] as { attemptId: string }
    expect(second.attemptId).not.toBe(first.attemptId)
    await delivery(notificationPost('delivery', { key, attemptId: first.attemptId, status: 'failed' }))
    const db = await openDesktopDatabase(root)
    expect((await db.execute('SELECT attempt_id FROM desktop_notification_attempts')).rows[0]!.attempt_id).toBe(second.attemptId)
    await delivery(notificationPost('delivery', { key, attemptId: second.attemptId, status: 'shown' }))
    await closeDesktopDatabase(root)
    expect((await (await readEvents(eventsGet())).json()).events.some((event: DesktopNotificationEvent) => event.key === key)).toBe(false)
    expect((await (await openDesktopDatabase(root)).execute('SELECT * FROM desktop_notification_attempts')).rows).toHaveLength(0)
})

test.each(['failed', 'unknown', 'unavailable', 'shown'] as const)('persists a native %s outcome separately from the delivered toast', async nativeStatus => {
    const { events } = await (await readEvents(eventsGet())).json() as { events: DesktopNotificationEvent[] }
    const key = events[0]!.key
    const { events: [admitted] } = await (await admit(notificationPost('admit', { keys: [key] }))).json()
    expect((await delivery(notificationPost('delivery', { key, attemptId: admitted.attemptId, status: 'shown', nativeStatus }))).status).toBe(200)
    await closeDesktopDatabase(root)
    const db = await openDesktopDatabase(root)
    expect((await db.execute({ sql: 'SELECT native_status FROM desktop_notifications_seen WHERE event_key=?', args: [key] })).rows)
        .toEqual([expect.objectContaining({ native_status: nativeStatus })])
    expect((await (await admit(notificationPost('admit', { keys: [key] }))).json()).events).toEqual([])
})

test('old acknowledged identities do not expire while a pending source still exists', async () => {
    const { events } = await (await readEvents(eventsGet())).json() as { events: DesktopNotificationEvent[] }
    const key = events[0]!.key
    await acknowledge(seenPost([key]))
    await (await openDesktopDatabase(root)).execute({ sql: 'UPDATE desktop_notifications_seen SET notified_at=? WHERE event_key=?', args: ['2020-01-01T00:00:00.000Z', key] })
    await acknowledge(seenPost(['pending:some-other-request']))
    await closeDesktopDatabase(root)
    expect((await (await readEvents(eventsGet())).json()).events.some((event: DesktopNotificationEvent) => event.key === key)).toBe(false)
})

test('terminal IDs are owner-scoped and an engine session rebound cannot retarget an old click', async () => {
    const payload = { kind: 'error', runId: 'shared-run-id', metadata: { status: 'error', source: 'chat' } }
    await enginePost(terminalPayload(payload))
    await enginePost(terminalPayload({ ...payload, agentId: bob.engineAgentId, sessionId: bobChat.engineSessionId }))
    const { events } = await (await readEvents(eventsGet())).json() as { events: DesktopNotificationEvent[] }
    expect(events.filter(event => event.kind === 'error').map(event => event.agentId).sort()).toEqual([alice.id, bob.id].sort())
    const oldId = terminalId('shared-run-id')
    const db = await openDesktopDatabase(root)
    await db.execute({ sql: 'UPDATE desktop_sessions SET engine_session_id=? WHERE id=?', args: ['alice-rebound', aliceChat.id] })
    await createDesktopSession(db, { agentId: alice.id, engineSessionId: 'alice-ask', title: 'Replacement chat' })
    expect((await terminalBinding(terminalGet(oldId), { params: Promise.resolve({ id: oldId }) })).status).toBe(404)
    expect((await (await readEvents(eventsGet())).json()).events.some((event: DesktopNotificationEvent) => event.terminalId === oldId)).toBe(false)
})

test('delivery routes authenticate, reject invalid receipts and bound their actual request bytes', async () => {
    expect((await admit(new Request(`${runtime.app.origin}/api/desktop/notifications/admit`, { method: 'POST', body: '{}' }))).status).not.toBe(200)
    expect((await delivery(notificationPost('delivery', { key: 'pending:example', attemptId: 'not-a-uuid', status: 'shown' }))).status).toBe(400)
    expect((await admit(notificationPost('admit', { keys: ['x'.repeat(40_001)] }))).status).toBe(413)
    expect((await writePrefs(prefsRequest({ scope: 'mine', extra: 'x'.repeat(40_001) }))).status).toBe(413)
})

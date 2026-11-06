import { createServer, type Server } from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { findDesktopTakeover, serializeTakeoverResult, type Message } from '@rerun/contracts'
import { closeDesktopDatabase, openDesktopDatabase } from '@/lib/desktop/server/database'
import { createDesktopAgent, createDesktopSession, type DesktopAgent, type DesktopSession } from '@/lib/desktop/server/store'
import type { DesktopPendingTakeover, DesktopTakeoverTerminal as DesktopTakeoverAnswer } from '@/lib/desktop/takeover'
import type { DesktopRuntime } from '@/lib/desktop/server/runtime'
import { GET, POST } from './route'

const originalEnv = { ...process.env }
let root: string, server: Server, runtime: DesktopRuntime, alice: DesktopAgent, bob: DesktopAgent, a: DesktopSession, b: DesktopSession
let rejectBeforeAccept: boolean, foreignHistory: boolean, historyReads: number, modelReads: number
let sourceUnavailable: boolean
const histories = new Map<string, Message[]>(), receipts = new Map<string, string>(), dispatches: Record<string, unknown>[] = []
const input = {url:'https://example.com/sign-in',reason:'Open the fixture'}
const activeLeases = new Map<string,string>(), finished: string[] = []

function message(sessionId: string, role: Message['role'], content: unknown, id = crypto.randomUUID()): Message {
    return { id, sessionId, role, contentJson: JSON.stringify(content), toolCallsJson: null, sourcesJson: null, createdAt: new Date().toISOString(), authorId: null }
}
function takeoverRows(sessionId: string, name = 'request_takeover', callId = 'takeover-call', value: unknown = input) {
    return [message(sessionId, 'assistant', [{ type: 'text', text: 'Please review these actions.' }, { type: 'tool-call', toolName: name, toolCallId: callId, input: value }]),
        message(sessionId, 'tool', [{ type: 'tool-result', toolName: name, toolCallId: callId, output: { type: 'json', value: { status: 'delivered' } } }])]
}
function request(sessionId: string, method = 'GET', body?: unknown, headers?: Record<string, string>) {
    const origin = runtime.app.origin
    return new Request(`${origin}/api/desktop/sessions/${sessionId}/takeovers`, { method, headers: { host: new URL(origin).host, origin,
        cookie: 'rerun-desktop-session=' + runtime.app.sessionToken, 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) })
}
const get = (sessionId = a.id) => GET(request(sessionId), { params: Promise.resolve({ sessionId }) })
const post = (body: unknown, sessionId = a.id, headers?: Record<string, string>) => POST(request(sessionId, 'POST', body, headers), { params: Promise.resolve({ sessionId }) })
const pending = async (sessionId = a.id) => (await (await get(sessionId)).json()).takeover as DesktopPendingTakeover
const answer = (takeover: DesktopPendingTakeover, action: 'done' | 'skip' = 'done'): DesktopTakeoverAnswer => ({ takeoverId: takeover.id, requestId: crypto.randomUUID(), action })

beforeEach(async () => {
    sourceUnavailable = false
    root = await mkdtemp(join(tmpdir(), 'rerun-takeover-api-'))
    activeLeases.clear(); finished.length=0; histories.clear(); receipts.clear(); dispatches.length = 0; rejectBeforeAccept = false; foreignHistory = false; historyReads = 0; modelReads = 0
    server = createServer(async (req, res) => {
        let raw = ''; for await (const part of req) raw += part
        const body = raw ? JSON.parse(raw) : null
        const reply = (status: number, value: unknown) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(value))
        if (req.method === 'POST' && req.url === '/desktop/triggers/manage') {
            if (req.headers.authorization !== `Bearer ${runtime.engine.apiKey}` || body.launchNonce !== runtime.launchNonce) return reply(403, { error: 'Wrong fixture launch' })
            const owner = body.engineAgentId === 'engine-alice' ? alice : body.engineAgentId === 'engine-bob' ? bob : null
            const sessionId = owner === alice ? 'engine-a' : 'engine-b'
            if (!owner || body.localAgentId !== owner.id || body.op !== 'session' || body.input?.sessionId !== sessionId) return reply(409, { error: 'Wrong fixture source' })
            if (sourceUnavailable) return reply(503, { error: 'Source identity unavailable' })
            // These are ordinary chats, proven by the canonical engine source lookup.
            return reply(200, { result: { event: null } })
        }
        if (req.method === 'GET' && /^\/agents\/(engine-alice|engine-bob)\/setup$/.test(req.url ?? '')) return reply(200, {
            required: false, prompt: '', completedAt: null, sessionId: null, pending: false, revision: 'fixture-setup',
        })
        if (req.method === 'GET' && req.url === '/connections') {
            modelReads++
            return reply(200, { connections: [{ id: 'provider', name: 'Fixture', provider: 'codex', models: ['workspace-model', 'chat-model'], extraModels: [], connected: true, credentialRejected: false, planLimits: null, createdAt: '' }], default: { connectionId: 'provider', model: 'workspace-model' } })
        }
        const screen = req.url?.match(/^\/agents\/(engine-alice|engine-bob)\/screen\/(takeover|takeover\/finish)$/)
        if (screen && req.method === 'POST') {
            if (screen[2] === 'takeover') {
                const held=activeLeases.get(screen[1])
                if(held) return held===body.lease ? reply(200,{lease:held}) : reply(409,{error:'Already controlled'})
                const lease=crypto.randomUUID();activeLeases.set(screen[1],lease);return reply(200,{lease})
            }
            if (activeLeases.get(screen[1]) !== body.lease) return reply(200,{url:null,expired:true})
            activeLeases.delete(screen[1]);finished.push(body.lease);return reply(200,{url:'https://example.com/verified'})
        }
        const agentMatch = req.url?.match(/^\/agents\/(engine-alice|engine-bob)$/)
        if (req.method === 'GET' && agentMatch) return reply(200, { id: agentMatch[1], config: { name: agentMatch[1], enabled: true }, soul: '' })
        const history = req.url?.match(/^\/agents\/(engine-alice|engine-bob)\/sessions\/([^/]+)\/messages$/)
        if (req.method === 'GET' && history) {
            historyReads++
            if ((history[1] === 'engine-alice' && history[2] !== 'engine-a') || (history[1] === 'engine-bob' && history[2] !== 'engine-b')) return reply(404, { error: 'Missing' })
            return reply(200, { messages: foreignHistory ? histories.get('engine-b') : histories.get(history[2]) ?? [] })
        }
        const chat = req.url?.match(/^\/agents\/(engine-alice|engine-bob)\/chat$/)
        if (req.method === 'POST' && chat) {
            const turn = body.desktopQueuedTurn
            const identity = JSON.stringify([chat[1], body.sessionId, body.message, turn?.takeover])
            if (receipts.has(turn?.runId)) {
                if (receipts.get(turn.runId) !== identity) return reply(409, { error: 'Different queued message' })
                return res.writeHead(204, { 'x-session-id': body.sessionId, 'x-run-id': turn.runId }).end()
            }
            if (turn?.replayOnly) return reply(404, { code: 'queued_turn_not_found' })
            dispatches.push(body)
            if (rejectBeforeAccept) return reply(503, { error: 'Provider unavailable' })
            const takeover = findDesktopTakeover(histories.get(body.sessionId) ?? [])
            if (!takeover || takeover.sourceMessageId !== turn?.takeover?.sourceMessageId || takeover.toolCallId !== turn.takeover.toolCallId || takeover.fingerprint !== turn.takeover.fingerprint) return reply(409, { error: 'Takeover is stale' })
            receipts.set(turn.runId, identity)
            histories.get(body.sessionId)!.push(message(body.sessionId, 'user', [{ type: 'text', text: body.message }]))
            return res.writeHead(200, { 'content-type': 'text/event-stream', 'x-session-id': body.sessionId, 'x-run-id': turn.runId }).end('data: [DONE]\n\n')
        }
        reply(404, { error: 'Missing fixture route' })
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing fixture address')
    runtime = { protocolVersion: 1, launchNonce: 'takeover-launch', buildId: 'takeover-api', workspaceId: 1, dataRoot: root,
        app: { origin: 'http://127.0.0.1:3197', sessionToken: 'a'.repeat(48) }, engine: { origin: `http://127.0.0.1:${address.port}`, apiKey: 'fixture-only' } }
    Object.assign(process.env, { RERUN_DESKTOP_APP: '1', RERUN_DESKTOP_DATA_DIR: root, RERUN_DESKTOP_RUNTIME_FILE: join(root, 'runtime.json') })
    await writeFile(join(root, 'runtime.json'), JSON.stringify(runtime), { mode: 0o600 })
    const db = await openDesktopDatabase(root)
    alice = await createDesktopAgent(db, { name: 'Alice', engineAgentId: 'engine-alice' }); bob = await createDesktopAgent(db, { name: 'Bob', engineAgentId: 'engine-bob' })
    a = await createDesktopSession(db, { agentId: alice.id, engineSessionId: 'engine-a', title: 'Alice chat', model: { connectionId: 'provider', model: 'chat-model' } })
    b = await createDesktopSession(db, { agentId: bob.id, engineSessionId: 'engine-b', title: 'Bob chat' })
    histories.set('engine-a', takeoverRows('engine-a')); histories.set('engine-b', takeoverRows('engine-b'))
})
afterEach(async () => {
    await closeDesktopDatabase(root); process.env = { ...originalEnv }
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    await rm(root, { recursive: true, force: true })
})

test('an unavailable source lookup cannot bypass webhook authority and dispatch an ordinary reply', async () => {
    const body = answer(await pending(), 'skip')
    sourceUnavailable = true
    expect((await post(body)).status).toBe(503)
    expect(dispatches).toHaveLength(0)
    expect(receipts.size).toBe(0)
    expect((await (await openDesktopDatabase(root)).execute('SELECT * FROM desktop_takeover_answers')).rows).toHaveLength(0)
    sourceUnavailable = false
    const response = await post(body)
    expect(response.status).toBe(200)
    expect(response.headers.get('x-run-id')).toBe(body.requestId)
    expect(dispatches).toHaveLength(1)
})


test('Done needs its own verified lease and never accepts a renderer URL',async()=>{
 const request=await pending()
 expect((await post(answer(request))).status).toBe(409)
 expect(dispatches).toHaveLength(0)
 expect((await post({...answer(request),url:'https://spoofed.test/'})).status).toBe(400)
 const opened=await post({action:'open',takeoverId:request.id,requestId:crypto.randomUUID()})
 expect(opened.status).toBe(200);const {lease}=await opened.json()
 const closed=await post({action:'release',takeoverId:request.id,requestId:crypto.randomUUID(),lease})
 expect(await closed.json()).toEqual({url:'https://example.com/verified'})
 expect(dispatches).toHaveLength(0)
 const payload=answer(request);expect((await post(payload)).status).toBe(200)
 expect(dispatches).toHaveLength(1);expect(dispatches[0].message).toBe(serializeTakeoverResult('https://example.com/verified'))
 expect(finished).toEqual([lease])
 await closeDesktopDatabase(root)
 expect((await post(payload)).status).toBe(200);expect(dispatches).toHaveLength(1)
 expect(await pending()).toBeNull()
})
test('Open reconciles an expired viewer lease and saves the fresh exact lease',async()=>{
 const request=await pending(),open=()=>post({action:'open',takeoverId:request.id,requestId:crypto.randomUUID()})
 const first=await (await open()).json()
 expect(await (await open()).json()).toEqual(first)
 activeLeases.delete('engine-alice')
 const fresh=await (await open()).json()
 expect(fresh.lease).not.toBe(first.lease)
 expect(await (await post({action:'release',takeoverId:request.id,requestId:crypto.randomUUID(),lease:first.lease})).json()).toEqual({url:null,expired:true})
 expect(activeLeases.get('engine-alice')).toBe(fresh.lease)
 expect((await post({action:'release',takeoverId:request.id,requestId:crypto.randomUUID(),lease:fresh.lease})).status).toBe(200)
 expect((await post(answer(request))).status).toBe(200)
})
test('restart expires an unfinished lease and Skip never releases a different coworker',async()=>{
 const first=await pending(),other=await pending(b.id)
 await post({action:'open',takeoverId:first.id,requestId:crypto.randomUUID()})
 const otherOpened=await (await post({action:'open',takeoverId:other.id,requestId:crypto.randomUUID()},b.id)).json()
 runtime.launchNonce='new-launch';await writeFile(join(root,'runtime.json'),JSON.stringify(runtime))
 expect((await post(answer(first))).status).toBe(409)
 expect((await post(answer(first,'skip'))).status).toBe(200)
 expect(activeLeases.get('engine-bob')).toBe(otherOpened.lease);expect(finished).toHaveLength(0)
})
test('lost provider acknowledgement keeps the same terminal decision for retry',async()=>{
 const request=await pending();rejectBeforeAccept=true
 const payload=answer(request,'skip');expect((await post(payload)).status).toBe(502)
 const saved=await pending();expect(saved.attempt).toEqual(payload)
 expect((await post({...payload,action:'done'})).status).toBe(409)
 await closeDesktopDatabase(root);rejectBeforeAccept=false
 expect((await post(payload)).status).toBe(200)
 expect(receipts.size).toBe(1)
})
test('foreign ownership and failed tool delivery cannot create a takeover',async()=>{
 const request=await pending()
 expect((await post({action:'open',takeoverId:request.id,requestId:crypto.randomUUID()},b.id)).status).toBe(409)
 histories.get('engine-a')![1].contentJson=JSON.stringify([{type:'tool-result',toolCallId:'takeover-call',output:{type:'error-text',value:'rejected'}}])
 expect(await pending()).toBeNull();expect((await post(answer(request,'skip'))).status).toBe(409)
 expect(activeLeases.size).toBe(0);expect(dispatches).toHaveLength(0)
})

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test, vi } from 'vitest'
import { DesktopHttpError } from '../auth'
import { closeDesktopDatabase, openDesktopDatabase } from '../database'
import { createDesktopAgent, createDesktopSession } from '../store'
import { authorizeDesktopCoworkerCall, listDesktopCoworkerCallTargets, replaceDesktopCoworkerCallAllows } from './authority'
import type { DesktopRuntime } from '../runtime'
import { ensureForemanChat } from '../foreman/chat-store'
import { setDesktopWorkspaceFrozen } from '../workspace-admission'
import { GET, PATCH } from '@/app/api/desktop/foreman/call-targets/route'

const mocks = vi.hoisted(() => ({ runtime: vi.fn(), getAgent: vi.fn() }))
vi.mock('../runtime', async original => ({ ...await original<typeof import('../runtime')>(), readDesktopRuntime: mocks.runtime }))
vi.mock('@/lib/engine/client', async original => ({ ...await original<typeof import('@/lib/engine/client')>(), getAgent: mocks.getAgent }))

let root: string
afterEach(async () => { if (root) { await closeDesktopDatabase(root); await rm(root, { recursive: true, force: true }) } })

const runtime = (dataRoot: string): DesktopRuntime => ({
    protocolVersion: 1, launchNonce: 'auth', buildId: 'auth', workspaceId: 1, dataRoot,
    app: { origin: 'http://127.0.0.1:9', sessionToken: 's'.repeat(48) },
    engine: { origin: 'http://127.0.0.1:1', apiKey: 'engine-key' },
})

test('allow-list writes reject duplicates, self and unknown ids, and public targets hide engine ids', async () => {
    root = await mkdtemp(join(tmpdir(), 'rerun-coworker-auth-'))
    const db = await openDesktopDatabase(root)
    const ann = await createDesktopAgent(db, { name: 'Ann', engineAgentId: 'engine-ann' })
    const bob = await createDesktopAgent(db, { name: 'Bob', engineAgentId: 'engine-bob' })
    await expect(replaceDesktopCoworkerCallAllows(db, ann.id, [bob.id, bob.id])).rejects.toBeInstanceOf(DesktopHttpError)
    await expect(replaceDesktopCoworkerCallAllows(db, ann.id, [ann.id])).rejects.toMatchObject({ status: 400 })
    await expect(replaceDesktopCoworkerCallAllows(db, ann.id, [crypto.randomUUID()])).rejects.toMatchObject({ status: 400 })
    await expect(replaceDesktopCoworkerCallAllows(db, crypto.randomUUID(), [])).rejects.toMatchObject({ status: 404 })
    await replaceDesktopCoworkerCallAllows(db, ann.id, [bob.id])
    const space = await db.execute({ sql: 'SELECT s.name FROM desktop_spaces s JOIN desktop_space_placements p ON p.space_id = s.id WHERE p.agent_id = ?', args: [bob.id] })
    const targets = await listDesktopCoworkerCallTargets(db, ann.id, true)
    expect(targets.map(target => target.agentId)).toContain(bob.id)
    expect(JSON.stringify(targets)).not.toContain('engine-')
    expect(targets.find(target => target.agentId === bob.id)).toMatchObject({ name: 'Bob', handle: null, boxName: String(space.rows[0]?.name), enabled: true, callable: true })
    expect((await listDesktopCoworkerCallTargets(db, ann.id, false)).every(target => target.callable === false)).toBe(true)
})

test('authorization uses the desktop grant, not the hosted callAgent switch', async () => {
    root = await mkdtemp(join(tmpdir(), 'rerun-coworker-grant-'))
    const db = await openDesktopDatabase(root)
    const ann = await createDesktopAgent(db, { name: 'Ann', engineAgentId: 'engine-ann' })
    const bob = await createDesktopAgent(db, { name: 'Bob', engineAgentId: 'engine-bob' })
    await replaceDesktopCoworkerCallAllows(db, ann.id, [bob.id])
    const session = await createDesktopSession(db, { agentId: ann.id, engineSessionId: 'engine-session', title: 'Chat' })
    const engineBody = (grant: boolean, runStatus = 'running') => async (url: string | URL | Request) => {
        const path = String(url)
        if (path.includes('/runs/')) return Response.json({ id: 'engine-run', agentId: 'engine-ann', sessionId: 'engine-session', status: runStatus })
        if (path.includes('/sessions/')) return Response.json({ id: 'engine-session', agentId: 'engine-ann' })
        return Response.json({ id: 'engine-ann', config: { enabled: true, tools: { callAgent: true, desktopToolGrants: grant ? { callAgent: true } : {} } } })
    }
    const input = { engineAgentId: 'engine-ann', engineSessionId: 'engine-session', engineRunId: 'engine-run' }
    const denied = await authorizeDesktopCoworkerCall(runtime(root), db, input, engineBody(false))
    expect(denied).toEqual({ ok: false, reason: 'Call coworkers is turned off for this coworker.' })
    const allowed = await authorizeDesktopCoworkerCall(runtime(root), db, input, engineBody(true))
    expect(allowed.ok).toBe(true)
    if (allowed.ok) {
        expect(allowed.caller.publicAgentId).toBe(ann.id)
        expect(allowed.caller.publicSessionId).toBe(session.id)
        expect(allowed.caller.targets.find(target => target.publicAgentId === bob.id)?.callable).toBe(true)
        expect(allowed.caller.targets.find(target => target.publicAgentId === bob.id)?.engineAgentId).toBe('engine-bob')
    }
    const stale = await authorizeDesktopCoworkerCall(runtime(root), db, input, engineBody(true, 'done'))
    expect(stale).toEqual({ ok: false, reason: 'This run can no longer call a coworker.' })
    await db.execute({ sql: 'UPDATE desktop_agents SET enabled = 0 WHERE id = ?', args: [ann.id] })
    expect(await authorizeDesktopCoworkerCall(runtime(root), db, input, engineBody(true))).toEqual({ ok: false, reason: 'This coworker is switched off and cannot be called.' })
    await db.execute({ sql: 'UPDATE desktop_agents SET enabled = 1 WHERE id = ?', args: [ann.id] })
    await db.execute({ sql: 'INSERT INTO desktop_deletions (agent_id, engine_agent_id, name) VALUES (?, ?, ?)', args: [ann.id, 'engine-ann', 'Ann'] })
    expect(await authorizeDesktopCoworkerCall(runtime(root), db, input, engineBody(true))).toEqual({ ok: false, reason: 'This run can no longer call a coworker.' })
})

test('Foreman calls require its own grant, exact current turn and separately selected targets', async () => {
    root = await mkdtemp(join(tmpdir(), 'rerun-foreman-calls-'))
    const live = { ...runtime(root), launchNonce: crypto.randomUUID() }
    mocks.runtime.mockResolvedValue(live)
    const db = await openDesktopDatabase(root)
    const foreman = await ensureForemanChat(db, String(live.workspaceId))
    const ann = await createDesktopAgent(db, { name: 'Ann', engineAgentId: 'engine-ann' })
    const bob = await createDesktopAgent(db, { name: 'Bob', engineAgentId: 'engine-bob' })
    await replaceDesktopCoworkerCallAllows(db, ann.id, [bob.id])
    const runId = crypto.randomUUID()
    const turn = { binding: { ...foreman.chat, runId, model: { connectionId: 'connection', model: 'fixture' } }, sessionId: foreman.sessionId, text: 'Call Bob', brief: { instructions: 'Fixture', tools: [] } }
    await db.execute({ sql: "INSERT INTO desktop_foreman_turns(request_id,chat_id,fingerprint,body,status,created_at) VALUES(?,?,?,?,'admitted',?)",
        args: [runId, foreman.chat.chatId, 'digest', JSON.stringify(turn), new Date().toISOString()] })
    let grant = false
    const detail = () => ({ id: 'foreman', config: { kind: 'foreman', enabled: true, tools: { callAgent: true, desktopToolGrants: { callAgent: grant } } } })
    mocks.getAgent.mockImplementation(async () => detail())
    const engine = async (url: string | URL | Request) => String(url).endsWith('/agents/foreman') ? Response.json(detail())
        : Response.json({ id: runId, agentId: 'foreman', sessionId: foreman.sessionId, status: 'running' })
    const caller = { engineAgentId: 'foreman', engineSessionId: foreman.sessionId, engineRunId: runId }
    const authorize = (input = caller) => authorizeDesktopCoworkerCall(live, db, input, engine)
    const request = (method: 'GET' | 'PATCH', scope = { ...foreman.chat, launchNonce: live.launchNonce }, authenticated = true) => new Request(
        `${live.app.origin}/api/desktop/foreman/call-targets?${new URLSearchParams(scope)}`,
        { method, headers: { host: new URL(live.app.origin).host, origin: live.app.origin, 'content-type': 'application/json',
            ...(authenticated && { cookie: `rerun-desktop-session=${live.app.sessionToken}` }) },
        ...(method === 'PATCH' && { body: JSON.stringify({ targetAgentIds: [bob.id], expectedTargetAgentIds: [] }) }) },
    )
    expect((await GET(request('GET', undefined, false))).status).toBe(401)
    expect((await PATCH(request('PATCH'))).status).toBe(409)
    expect((await authorize()).ok).toBe(false)
    grant = true
    const before = await authorize()
    expect(before.ok && before.caller.targets.every(target => !target.callable)).toBe(true)
    expect((await PATCH(request('PATCH', { ...foreman.chat, workspaceId: '2', launchNonce: live.launchNonce }))).status).toBe(409)
    expect((await PATCH(request('PATCH', { ...foreman.chat, launchNonce: crypto.randomUUID() }))).status).toBe(409)
    expect((await PATCH(request('PATCH'))).status).toBe(200)
    const after = await authorize()
    expect(after.ok && after.caller).toMatchObject({ publicAgentId: 'foreman', publicSessionId: foreman.chat.chatId,
        targets: expect.arrayContaining([expect.objectContaining({ publicAgentId: bob.id, callable: true }), expect.objectContaining({ publicAgentId: ann.id, callable: false })]) })
    expect((await authorize({ ...caller, engineSessionId: 'not-foreman-session' })).ok).toBe(false)
    setDesktopWorkspaceFrozen(live, true)
    try { expect((await authorize()).ok).toBe(false) }
    finally { setDesktopWorkspaceFrozen(live, false) }
    grant = false
    expect((await authorize()).ok).toBe(false)
})

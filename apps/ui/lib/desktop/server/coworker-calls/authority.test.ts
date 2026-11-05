import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { DesktopHttpError } from '../auth'
import { closeDesktopDatabase, openDesktopDatabase } from '../database'
import { createDesktopAgent, createDesktopSession } from '../store'
import { authorizeDesktopCoworkerCall, listDesktopCoworkerCallTargets, replaceDesktopCoworkerCallAllows } from './authority'
import type { DesktopRuntime } from '../runtime'

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

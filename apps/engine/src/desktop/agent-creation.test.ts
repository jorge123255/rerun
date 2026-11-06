import { mkdtempSync } from 'node:fs'
import { cp, rename, lstat, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, expect, test, vi } from 'vitest'
import { desktopRerunGrantsOf } from '@rerun/contracts'
import { prepareSkillHelperFixture } from './skill-publication.test-support.js'

process.env.RERUN_DATA_DIR = mkdtempSync(join(tmpdir(), 'rerun-create-desktop-'))
process.env.RERUN_DESKTOP_APP = '1'
process.env.RERUN_API_KEY = 'desktop-create-test-key'
process.env.RERUN_HUB_BASE_URL = ''
process.env.RERUN_DESKTOP_SECRET_KEY = '6'.repeat(64)
const { createServer } = await import('../http/server.js')
const { migrate } = await import('../db/migrate.js')
const { agentDir, agentsDir } = await import('../config/paths.js')
const { listAgentIdsOnDisk } = await import('../agents/loader.js')
const { deleteAgentIndex, getAgentIndex, insertAgentIndex, listAgentIndex } = await import('../db/repos/agents.js')
const { createDesktopAgent, createDesktopForemanAgent, readDesktopForemanAgentCreation, setDesktopAgentCreationHooksForTests } = await import('./agent-creation.js')
const { desktopRouteAllowed } = await import('./policy.js')
const app = createServer()
const headers = { 'content-type': 'application/json', authorization: 'Bearer desktop-create-test-key' }
const config = { name: 'creation-test', displayName: 'New coworker', description: 'This exact kickoff is not permanent SOUL instructions.' }
const input = () => ({ requestId: crypto.randomUUID(), config: { ...config } })
const send = (body: unknown) => app.request('/desktop/agents/create', { method: 'POST', headers, body: JSON.stringify(body) })
let helper: Awaited<ReturnType<typeof prepareSkillHelperFixture>>
const priorHelper = process.env.RERUN_DESKTOP_RENAME_HELPER
beforeAll(async () => { helper = await prepareSkillHelperFixture(); process.env.RERUN_DESKTOP_RENAME_HELPER = helper.path; await migrate() })
afterEach(() => setDesktopAgentCreationHooksForTests(null))
afterAll(async () => {
    if (priorHelper === undefined) delete process.env.RERUN_DESKTOP_RENAME_HELPER; else process.env.RERUN_DESKTOP_RENAME_HELPER = priorHelper
    await helper?.close()
    await rm(process.env.RERUN_DATA_DIR!, { recursive: true, force: true })
})

test('authenticated concurrent retries publish exactly one deterministic coworker and no chat or grants', async () => {
    const body = input()
    expect((await app.request('/desktop/agents/create', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).status).toBe(401)
    const responses = await Promise.all(Array.from({ length: 6 }, () => send(body)))
    expect(responses.map(response => response.status)).toEqual(Array(6).fill(201))
    const values = await Promise.all(responses.map(response => response.json())) as { id: string; soul: string; config: { tools: { desktopToolGrants: Record<string, boolean> } } }[]
    const id = `new-${body.requestId}`
    expect(values.every(value => value.id === id)).toBe(true)
    expect(values[0].soul).not.toContain(config.description)
    expect(Object.values(desktopRerunGrantsOf(values[0].config.tools)).some(Boolean)).toBe(false)
    expect((await listAgentIndex()).filter(row => row.id === id)).toHaveLength(1)
    expect(await readdir(agentDir(id))).not.toContain('data')
    expect(await readdir(agentsDir())).not.toContain(`.desktop-new-${body.requestId}`)
})

test('the same UUID with different exact input refuses rather than replacing the first result', async () => {
    const body = input()
    expect((await send(body)).status).toBe(201)
    const path = join(agentDir(`new-${body.requestId}`), 'config.json')
    const before = await readFile(path, 'utf8')
    expect((await send({ ...body, config: { ...body.config, displayName: 'Different' } })).status).toBe(409)
    // Explicit default versus omitted default is a different submitted intent too.
    expect((await send({ ...body, config: { ...body.config, enabled: true } })).status).toBe(409)
    expect(await readFile(path, 'utf8')).toBe(before)
})

test('prepared staging is invisible, and retry publishes that same inode after an interrupted response', async () => {
    const body = input(), id = `new-${body.requestId}`
    setDesktopAgentCreationHooksForTests({ afterPrepared: async () => { throw new Error('simulated process loss') } })
    await expect(createDesktopAgent(body)).rejects.toThrow('simulated process loss')
    const stage = join(agentsDir(), `.desktop-new-${body.requestId}`)
    const before = await lstat(stage, { bigint: true })
    expect(await listAgentIdsOnDisk()).not.toContain(id)
    expect(await listAgentIdsOnDisk()).not.toContain(`.desktop-new-${body.requestId}`)
    expect(await getAgentIndex(id)).toBeUndefined()
    setDesktopAgentCreationHooksForTests(null)
    vi.resetModules()
    const restarted = await import('./agent-creation.js')
    expect((await restarted.createDesktopAgent(body)).id).toBe(id)
    expect((await lstat(agentDir(id), { bigint: true })).ino).toBe(before.ino)
    expect(await getAgentIndex(id)).toMatchObject({ id })
})

test.each(['afterPublished', 'afterIndexed'] as const)('retry completes %s without another directory or index row', async boundary => {
    const body = input(), id = `new-${body.requestId}`
    setDesktopAgentCreationHooksForTests({ [boundary]: async () => { throw new Error('simulated process loss') } })
    await expect(createDesktopAgent(body)).rejects.toThrow('simulated process loss')
    const before = await readFile(join(agentDir(id), 'config.json'), 'utf8')
    setDesktopAgentCreationHooksForTests(null)
    expect((await createDesktopAgent(body)).id).toBe(id)
    expect(await readFile(join(agentDir(id), 'config.json'), 'utf8')).toBe(before)
    expect((await listAgentIndex()).filter(row => row.id === id)).toHaveLength(1)
})

test('completed receipt can repair a missing index without resetting later human edits', async () => {
    const body = input(), id = `new-${body.requestId}`
    expect((await send(body)).status).toBe(201)
    const patch = await app.request(`/agents/${id}`, { method: 'PATCH', headers, body: JSON.stringify({ name: 'renamed-after-creation', soul: 'Keep these accepted human instructions.' }) })
    expect(patch.status).toBe(200)
    await deleteAgentIndex(id)
    const retry = await send(body)
    expect(retry.status).toBe(201)
    expect(await retry.json()).toMatchObject({ id, config: { name: 'renamed-after-creation' }, soul: 'Keep these accepted human instructions.\n' })
    expect(await getAgentIndex(id)).toMatchObject({ name: 'renamed-after-creation' })
})

test('partial or replaced published files are not recreated from the receipt', async () => {
    const body = input(), id = `new-${body.requestId}`
    expect((await send(body)).status).toBe(201)
    await rm(join(agentDir(id), 'SOUL.md'))
    expect((await send(body)).status).toBe(409)
    await expect(readFile(join(agentDir(id), 'SOUL.md'))).rejects.toMatchObject({ code: 'ENOENT' })
})

test('damaged staged bytes fail closed and are preserved for recovery', async () => {
    const body = input()
    setDesktopAgentCreationHooksForTests({ afterPrepared: async () => { throw new Error('interrupted') } })
    await expect(createDesktopAgent(body)).rejects.toThrow('interrupted')
    setDesktopAgentCreationHooksForTests(null)
    const file = join(agentsDir(), `.desktop-new-${body.requestId}`, '.desktop-new-config.json')
    await writeFile(file, 'incomplete config')
    expect((await send(body)).status).toBe(409)
    expect(await readFile(file, 'utf8')).toBe('incomplete config')
    expect(await getAgentIndex(`new-${body.requestId}`)).toBeUndefined()
})

test('unowned directories, orphan index rows and linked receipts cannot be adopted', async () => {
    const foreign = input(), orphan = input(), linked = input()
    await mkdir(agentDir(`new-${foreign.requestId}`))
    await writeFile(join(agentDir(`new-${foreign.requestId}`), 'keep.txt'), 'Unrelated data')
    expect((await send(foreign)).status).toBe(409)
    expect(await readFile(join(agentDir(`new-${foreign.requestId}`), 'keep.txt'), 'utf8')).toBe('Unrelated data')
    await insertAgentIndex(`new-${orphan.requestId}`, 'unrelated-row')
    expect((await send(orphan)).status).toBe(409)
    await expect(lstat(agentDir(`new-${orphan.requestId}`))).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await send(linked)).status).toBe(201)
    const receipt = join(agentDir(`new-${linked.requestId}`), '.desktop-creation.json')
    const original = await readFile(receipt, 'utf8')
    const outside = join(process.env.RERUN_DATA_DIR!, 'outside-receipt.json')
    await writeFile(outside, original)
    await rm(receipt)
    await symlink(outside, receipt)
    expect((await send(linked)).status).toBe(409)
    expect(await readFile(outside, 'utf8')).toBe(original)
})

test('a durable deletion prevents a completed creation request from recreating its coworker', async () => {
    const body = input(), id = `new-${body.requestId}`
    expect((await send(body)).status).toBe(201)
    expect((await app.request(`/agents/${id}`, { method: 'DELETE', headers })).status).toBe(200)
    expect((await send(body)).status).toBe(404)
    expect(await getAgentIndex(id)).toBeUndefined()
    await expect(lstat(agentDir(id))).rejects.toMatchObject({ code: 'ENOENT' })
})

test('route accepts only the bounded desktop creation contract and is closed to other methods', async () => {
    expect((await send({ ...input(), keys: { KEY: 'never admitted' } })).status).toBe(400)
    const grants = input()
    expect((await send({ ...grants, config: { ...grants.config, tools: { desktopRerun: true } } })).status).toBe(400)
    expect((await send({ ...input(), config: { name: 'x'.repeat(40_000) } })).status).toBe(413)
    expect((await send({ requestId: '../bad', config })).status).toBe(400)
    expect(desktopRouteAllowed('POST', '/desktop/agents/create')).toBe(true)
    for (const method of ['GET', 'PATCH', 'PUT', 'DELETE']) expect(desktopRouteAllowed(method, '/desktop/agents/create')).toBe(false)
    expect(desktopRouteAllowed('POST', '/desktop/agents/create/more')).toBe(false)
})

test('cancelling an unread request body cannot admit a creation later', async () => {
    const body = input()
    const controller = new AbortController()
    let stream!: ReadableStreamDefaultController<Uint8Array>
    let started!: () => void
    const reading = new Promise<void>(resolve => { started = resolve })
    const request = new Request('http://localhost/desktop/agents/create', {
        method: 'POST', headers, signal: controller.signal,
        body: new ReadableStream<Uint8Array>({ start(value) { stream = value }, pull() { started() } }, { highWaterMark: 0 }),
        duplex: 'half',
    } as RequestInit)
    const response = app.request(request)
    await reading
    controller.abort()
    expect((await response).status).toBe(408)
    expect(() => stream.enqueue(new TextEncoder().encode(JSON.stringify(body)))).toThrow()
    expect(await getAgentIndex(`new-${body.requestId}`)).toBeUndefined()
    await expect(lstat(agentDir(`new-${body.requestId}`))).rejects.toMatchObject({ code: 'ENOENT' })
})


test('trusted Foreman creation publishes exact SOUL and INSTALL, disabled pending setup and no new grants', async () => {
    const body = { requestId: crypto.randomUUID(), config: { ...config, enabled: false as const, connectionId: 'offline-codex', provider: 'codex' as const, model: 'terra' }, instructions: { soulMd: '# Mission\nKeep these exact bytes.\n', installMd: '# Setup\nAsk the user for their goal.\n' } }
    const made = await createDesktopForemanAgent(body)
    expect(made).toMatchObject({ id: `new-${body.requestId}`, soul: body.instructions.soulMd, install: body.instructions.installMd, config: { enabled: false, connectionId: 'offline-codex', model: 'terra', setup: { required: true, completedAt: null, sessionId: null } } })
    expect(Object.values(desktopRerunGrantsOf(made.config.tools)).some(Boolean)).toBe(false)
    expect(await readdir(agentDir(made.id))).not.toContain('data')
    expect(await readDesktopForemanAgentCreation(body.requestId)).toMatchObject({ state: 'present', id: made.id, instructions: body.instructions })
    await expect(createDesktopForemanAgent({ ...body, instructions: { ...body.instructions, soulMd: 'Changed' } })).rejects.toMatchObject({ status: 409 })
    expect((await send({ ...body })).status).toBe(400)
    await expect(createDesktopForemanAgent({ ...body, config: { ...body.config, enabled: true as never } })).rejects.toThrow()
})

test('Foreman partial publication resumes the same original directory and receipt after restart', async () => {
    const body = { requestId: crypto.randomUUID(), config: { ...config, enabled: false as const, connectionId: 'offline-codex', provider: 'codex' as const, model: 'terra' }, instructions: { soulMd: 'Exact mission', installMd: 'Exact setup' } }
    setDesktopAgentCreationHooksForTests({ afterPublished: async () => { throw new Error('lost before index') } })
    await expect(createDesktopForemanAgent(body)).rejects.toThrow('lost before index')
    const id = `new-${body.requestId}`, before = await lstat(agentDir(id), { bigint: true })
    expect(await readDesktopForemanAgentCreation(body.requestId)).toEqual({ state: 'unknown' })
    setDesktopAgentCreationHooksForTests(null)
    vi.resetModules()
    const restarted = await import('./agent-creation.js')
    expect((await restarted.createDesktopForemanAgent(body)).id).toBe(id)
    expect((await lstat(agentDir(id), { bigint: true })).ino).toBe(before.ino)
    expect((await listAgentIndex()).filter(row => row.id === id)).toHaveLength(1)
    expect(await restarted.readDesktopForemanAgentCreation(body.requestId)).toMatchObject({ state: 'present', id })
    const original = `${agentDir(id)}-kept-original`
    await rename(agentDir(id), original)
    await cp(original, agentDir(id), { recursive: true })
    expect(await restarted.readDesktopForemanAgentCreation(body.requestId)).toEqual({ state: 'replaced' })
    await expect(restarted.createDesktopForemanAgent(body)).rejects.toMatchObject({ status: 409 })
})

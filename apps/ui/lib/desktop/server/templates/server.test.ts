import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createClient, type Client } from '@libsql/client'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { DESKTOP_TEMPLATE_LIMITS, DESKTOP_TEMPLATE_PROSE_WARNING, desktopTemplateOperationSchema, desktopTemplateSkillFileSchema } from '@rerun/contracts'
import { prepareTemplateIntent, readTemplateInstallIntent } from './intents'
import { commitDesktopTemplateInstall } from './commit'
import { initializeDesktopTemplates } from './schema'
import { createDesktopTemplateServer, type DesktopTemplateEngineClient } from './server'

const spaceId = '44444444-4444-4444-8444-444444444444'
const templateId = 'ab'.repeat(16)
const revision = 'cd'.repeat(32)
const requestId = '66666666-6666-4666-8666-666666666666'
const localId = '11111111-1111-4111-8111-111111111111'
let db: Client
let directory: string

const detail = {
    templateId, title: 'Pack notes', revision, capturedAt: '2026-11-05T12:00:00.000Z',
    proseWarning: DESKTOP_TEMPLATE_PROSE_WARNING, limits: DESKTOP_TEMPLATE_LIMITS, engineCommit: null,
    coworkers: [{
        agentKey: 'c00', name: 'Ada', description: 'Keeps the notes',
        setup: { required: true, prompt: 'Say hello', answered: true },
        files: [], exclusions: [], redactions: [], strippedConfigKeys: [], envKeys: [], mcpAuth: [],
    }],
}

function engineFor(): { engine: DesktopTemplateEngineClient; posts: { path: string; body: unknown }[] } {
    const posts: { path: string; body: unknown }[] = []
    return {
        posts,
        engine: {
            get: async () => detail,
            post: async (path, body) => {
                posts.push({ path, body })
                if (path === '/desktop/templates/draft') {
                    const request = body as { requestId: string }
                    return { requestId: request.requestId, templateId, revision }
                }
                if (path === '/desktop/templates/install') {
                    const coworkers = (body as { coworkers: { engineAgentId: string; agentKey: string }[] }).coworkers
                    return { status: 'ready', coworkers: coworkers.map(coworker => ({ ...coworker, name: 'Ada', description: 'Keeps the notes', phase: 'indexed' })) }
                }
                throw new Error(`unexpected ${path}`)
            },
        },
    }
}

const install = { operation: 'install' as const, requestId, templateId, revision, spaceId, positions: [{ col: 0, row: 0 }] }

beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'rerun-template-ui-'))
    db = createClient({ url: `file:${join(directory, 'app.db')}` })
    await db.executeMultiple(`
        CREATE TABLE desktop_agents (
            id TEXT PRIMARY KEY, workspace_id INTEGER NOT NULL, engine_agent_id TEXT NOT NULL UNIQUE,
            name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', enabled INTEGER NOT NULL DEFAULT 1,
            created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
        CREATE TABLE desktop_spaces (
            id TEXT PRIMARY KEY, workspace_id INTEGER NOT NULL, name TEXT NOT NULL,
            col_start INTEGER NOT NULL, row_start INTEGER NOT NULL, col_end INTEGER NOT NULL, row_end INTEGER NOT NULL);
        CREATE TABLE desktop_space_placements (
            agent_id TEXT PRIMARY KEY, space_id TEXT NOT NULL, col INTEGER NOT NULL, row INTEGER NOT NULL);
        CREATE TABLE desktop_board_state (workspace_id INTEGER PRIMARY KEY, revision INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE desktop_duplicates (
            request_id TEXT PRIMARY KEY, source_id TEXT NOT NULL, agent_id TEXT NOT NULL, name TEXT NOT NULL,
            handle TEXT NOT NULL, board_col INTEGER NOT NULL, board_row INTEGER NOT NULL,
            completed INTEGER NOT NULL DEFAULT 0, space_id TEXT);
        CREATE TABLE desktop_creations (
            request_id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, space_id TEXT NOT NULL,
            board_col INTEGER NOT NULL, board_row INTEGER NOT NULL, phase TEXT NOT NULL);
    `)
    await initializeDesktopTemplates(db)
    await db.execute({ sql: 'INSERT INTO desktop_spaces (id, workspace_id, name, col_start, row_start, col_end, row_end) VALUES (?,1,?,?,?,?,?)', args: [spaceId, 'Box', 0, 0, 10, 10] })
    await db.execute('INSERT INTO desktop_board_state (workspace_id, revision) VALUES (1, 0)')
})
afterEach(async () => { db.close(); await rm(directory, { recursive: true, force: true }) })

test('create-draft keeps one receipt and refuses a different title', async () => {
    const { engine, posts } = engineFor()
    const server = createDesktopTemplateServer({ db, engine })
    const first = await server.handle({ operation: 'create-draft', requestId, title: 'Pack notes' })
    const second = await server.handle({ operation: 'create-draft', requestId, title: 'Pack notes' })
    expect(second).toEqual(first)
    expect(first).toMatchObject({ requestId, templateId, revision })
    expect(posts.map(call => call.path)).toEqual(['/desktop/templates/draft', '/desktop/templates/draft'])
    await expect(server.handle({ operation: 'create-draft', requestId, title: 'Other title' })).rejects.toMatchObject({ status: 409 })
    expect(posts).toHaveLength(2)
    expect((await db.execute('SELECT request_id FROM desktop_template_requests')).rows).toHaveLength(1)
})

test('sources name local coworkers and omit engine ids', async () => {
    const now = new Date().toISOString()
    await db.execute({
        sql: 'INSERT INTO desktop_agents (id, workspace_id, engine_agent_id, name, description, enabled, created_at, updated_at) VALUES (?,1,?,?,?,1,?,?)',
        args: [localId, 'engine-secret-id', 'Ada', 'Keeps the notes', now, now],
    })
    const server = createDesktopTemplateServer({ db, engine: engineFor().engine })
    const sources = await server.handle({ operation: 'sources' })
    expect(JSON.stringify(sources)).not.toContain('engine-secret-id')
    expect(sources).toEqual({ spaces: [{ id: null, name: null, agents: [{ id: localId, name: 'Ada', description: 'Keeps the notes' }] }] })
})

test('install stays recoverable and does not call the engine until placement and setup are connected', async () => {
    const missingCommit = engineFor()
    const recoverable = await createDesktopTemplateServer({ db, engine: missingCommit.engine, initializeImportedSetup: async () => ({ revision: 'setup-rev-1' }) }).handle(install)
    expect(recoverable).toMatchObject({ status: 'recoverable', reason: expect.stringContaining('placement') })
    expect(missingCommit.posts).toEqual([])

    const missingSetup = engineFor()
    const setup = await createDesktopTemplateServer({ db, engine: missingSetup.engine, commitInstalled: input => commitDesktopTemplateInstall(db, input) }).handle({ ...install, requestId: '77777777-7777-4777-8777-777777777777' })
    expect(setup).toMatchObject({ status: 'recoverable', reason: expect.stringContaining('setup') })
    expect(missingSetup.posts).toEqual([])
})

test('install returns coworker views only after setup and the placement commit, without engine ids', async () => {
    const { engine, posts } = engineFor()
    const order: string[] = []
    let seenEngineId = ''
    const server = createDesktopTemplateServer({
        db, engine,
        initializeImportedSetup: async input => {
            order.push('setup')
            seenEngineId = input.engineAgentId
            expect(input.required).toBe(true)
            expect(input.prompt).toBe('Say hello')
            return { revision: 'setup-rev-1' }
        },
        commitInstalled: async input => {
            order.push('commit')
            return commitDesktopTemplateInstall(db, input)
        },
    })
    const result = await server.handle(install)
    if (!('coworkers' in result) || !('status' in result) || result.status !== 'installed') throw new Error('expected installed')
    expect(order).toEqual(['setup', 'commit'])
    expect(posts.map(call => call.path)).toEqual(['/desktop/templates/install'])
    expect(result.coworkers).toHaveLength(1)
    expect(result.coworkers[0]).toMatchObject({ name: 'Ada', description: 'Keeps the notes', enabled: true, position: { col: 0, row: 0 }, spaceId })
    expect(JSON.stringify(result)).not.toContain(seenEngineId)
    expect('engineAgentId' in result.coworkers[0]!).toBe(false)
    const replay = await server.handle(install)
    expect(replay).toMatchObject({ status: 'installed', coworkers: [{ id: result.coworkers[0]?.id }] })
    expect(order).toEqual(['setup', 'commit'])
    expect(posts).toHaveLength(1)
    expect((await db.execute('SELECT id FROM desktop_agents')).rows).toHaveLength(1)
})

test('a failed placement stays uncertain and a retry keeps the same coworker ids', async () => {
    const { engine, posts } = engineFor()
    const server = createDesktopTemplateServer({
        db, engine,
        initializeImportedSetup: async () => ({ revision: 'setup-rev-1' }),
        commitInstalled: async () => { throw new Error('disk') },
    })
    const first = await server.handle(install)
    if (!('status' in first) || first.status !== 'uncertain') throw new Error('expected uncertain')
    const agentId = first.created[0]?.agentId
    const second = await server.handle(install)
    if (!('status' in second) || second.status !== 'uncertain') throw new Error('expected uncertain')
    expect(second.created[0]?.agentId).toBe(agentId)
    expect(second.receiptId).toBe(first.receiptId)
    expect(posts).toHaveLength(2)
    expect((await db.execute('SELECT id FROM desktop_agents')).rows).toEqual([])
})

test('an occupied spot is refused before install starts', async () => {
    await db.execute({ sql: 'INSERT INTO desktop_space_placements (agent_id, space_id, col, row) VALUES (?,?,0,0)', args: [localId, spaceId] })
    const { engine, posts } = engineFor()
    const server = createDesktopTemplateServer({
        db, engine,
        initializeImportedSetup: async () => ({ revision: 'setup-rev-1' }),
        commitInstalled: input => commitDesktopTemplateInstall(db, input),
    })
    await expect(server.handle(install)).rejects.toMatchObject({ status: 409 })
    expect(posts).toEqual([])
    const row = (await db.execute('SELECT status, payload FROM desktop_template_requests')).rows[0]
    expect(String(row?.status)).toBe('refused')
    expect(JSON.parse(String(row?.payload)).engineStarted).toBe(false)
})

test('browser template operations reject an engine id', () => {
    const engineAgentId = `i${'a'.repeat(31)}`
    expect(desktopTemplateOperationSchema.safeParse({ ...install, engineAgentId }).success).toBe(false)
    expect(desktopTemplateOperationSchema.safeParse({
        operation: 'plan', requestId, templateId, revision, agentIds: [localId], engineAgentId: 'source-ada',
    }).success).toBe(false)
    expect(desktopTemplateSkillFileSchema.safeParse({
        path: 'skills/Local/SKILL.md', bytes: 1, kind: 'skill', sourceRevision: revision, flagged: [], extra: true,
    }).success).toBe(false)
})

test('placement commit is idempotent and keeps reserved creations and other tiles', async () => {
    const receiptId = '88888888-8888-4888-8888-888888888888'
    const agentId = '99999999-9999-4999-8999-999999999999'
    const engineAgentId = `i${'a'.repeat(31)}`
    const now = new Date().toISOString()
    await db.execute({
        sql: `INSERT INTO desktop_template_requests (request_id, receipt_id, operation, template_id, revision, fingerprint, status, payload, created_at, updated_at)
              VALUES (?,?, 'install', ?, ?, 'fingerprint', 'committing', '{}', ?, ?)`,
        args: [requestId, receiptId, templateId, revision, now, now],
    })
    const input = { requestId, receiptId, templateId, revision, spaceId, coworkers: [{ agentId, engineAgentId, name: 'Ada', description: 'Keeps the notes', position: { col: 0, row: 0 } }] }
    expect(await commitDesktopTemplateInstall(db, input)).toEqual({ acknowledged: true })
    expect(await commitDesktopTemplateInstall(db, input)).toEqual({ acknowledged: true })
    expect((await db.execute('SELECT id FROM desktop_agents')).rows).toHaveLength(1)
    expect(Number((await db.execute('SELECT revision FROM desktop_board_state')).rows[0]?.revision)).toBe(2)
    await expect(commitDesktopTemplateInstall(db, {
        ...input, requestId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', receiptId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        coworkers: [{ ...input.coworkers[0], agentId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', engineAgentId: `i${'b'.repeat(31)}`, position: { col: 1, row: 0 } }],
    })).rejects.toMatchObject({ status: 409 })
    await db.execute({
        sql: `INSERT INTO desktop_creations (request_id, agent_id, space_id, board_col, board_row, phase) VALUES (?,?,?,?,?, 'reserved')`,
        args: ['dddddddd-dddd-4ddd-8ddd-dddddddddddd', localId, spaceId, 4, 4],
    })
    await expect(commitDesktopTemplateInstall(db, {
        ...input, requestId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', receiptId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
        coworkers: [{ ...input.coworkers[0], agentId: '12121212-1212-4121-8121-121212121212', engineAgentId: `i${'c'.repeat(31)}`, position: { col: 4, row: 4 } }],
    })).rejects.toMatchObject({ status: 409 })
    expect((await db.execute('SELECT id FROM desktop_agents')).rows).toHaveLength(1)
})


test('a saved install intent and Use again survive lost acknowledgements and a recreated client', async()=>{
    const {engine}=engineFor()
    const body={operation:{operation:'install',templateId,revision}}
    const first=await prepareTemplateIntent(db,engine,body)
    expect(first.operation).toBe('install')
    const reopened=createClient({url:`file:${join(directory,'app.db')}`})
    try {
        expect(await prepareTemplateIntent(reopened,engine,body)).toEqual(first)
        const server=createDesktopTemplateServer({db,engine,initializeImportedSetup:async()=>({revision:'setup'}),commitInstalled:input=>commitDesktopTemplateInstall(db,input)})
        const installed=await server.handle(first)
        if(!('coworkers' in installed))throw new Error('Expected coworkers')
        await db.execute({sql:'UPDATE desktop_agents SET name=? WHERE id=?',args:['Renamed after import',installed.coworkers[0]!.id]})
        expect(await server.handle(first)).toMatchObject({status:'installed',coworkers:[{name:'Renamed after import'}]})
        const again={...body,againRequestId:crypto.randomUUID()}
        const next=await prepareTemplateIntent(db,engine,again)
        expect(await prepareTemplateIntent(reopened,engine,again)).toEqual(next)
        expect(next).not.toEqual(first)
        expect(await prepareTemplateIntent(reopened,engine,body)).toEqual(next)
    } finally {reopened.close()}
})

test('opening install status never reserves or executes an installation', async () => {
    const identity = { templateId, revision }
    expect(await readTemplateInstallIntent(db, identity)).toEqual({ status: 'none', ...identity })
    expect((await db.execute('SELECT * FROM desktop_template_intents')).rows).toEqual([])
    expect((await db.execute('SELECT * FROM desktop_template_requests')).rows).toEqual([])
    const { engine, posts } = engineFor()
    const operation = await prepareTemplateIntent(db, engine, { operation: { operation: 'install', ...identity } })
    if (operation.operation !== 'install') throw new Error('Expected install')
    expect(await readTemplateInstallIntent(db, identity)).toEqual({ status: 'pending', ...identity, requestId: operation.requestId })
    expect(posts).toEqual([])
    expect((await db.execute('SELECT * FROM desktop_template_requests')).rows).toEqual([])
    expect((await db.execute('SELECT * FROM desktop_agents')).rows).toEqual([])
})

test('read-only install status survives restart, uses renamed coworkers and follows the latest rotation', async () => {
    const identity = { templateId, revision }
    const body = { operation: { operation: 'install', ...identity } }
    const { engine, posts } = engineFor()
    const operation = await prepareTemplateIntent(db, engine, body)
    const server = createDesktopTemplateServer({ db, engine, initializeImportedSetup: async () => ({ revision: 'setup' }), commitInstalled: input => commitDesktopTemplateInstall(db, input) })
    const installed = await server.handle(operation)
    if (!('status' in installed) || installed.status !== 'installed') throw new Error('Expected installed')
    await db.execute({ sql: 'UPDATE desktop_agents SET name=? WHERE id=?', args: ['Renamed after import', installed.coworkers[0]!.id] })
    const snapshot = async () => Promise.all(['desktop_template_intents', 'desktop_template_requests', 'desktop_template_rotations', 'desktop_agents', 'desktop_board_state'].map(async table => (await db.execute(`SELECT * FROM ${table}`)).rows))
    const before = await snapshot()
    const reopened = createClient({ url: `file:${join(directory, 'app.db')}` })
    try {
        expect(await readTemplateInstallIntent(reopened, identity)).toMatchObject({ status: 'installed', requestId: installed.requestId, receiptId: installed.receiptId, coworkers: [{ id: installed.coworkers[0]!.id, name: 'Renamed after import' }] })
        expect(await snapshot()).toEqual(before)
        expect(posts).toHaveLength(1)
        const again = await prepareTemplateIntent(db, engine, { ...body, againRequestId: crypto.randomUUID() })
        if (again.operation !== 'install') throw new Error('Expected install')
        expect(await readTemplateInstallIntent(reopened, identity)).toEqual({ status: 'pending', ...identity, requestId: again.requestId })
        expect(again.requestId).not.toBe(installed.requestId)
        expect(posts).toHaveLength(1)
    } finally { reopened.close() }
})

test('installed status omits deleted coworkers but refuses a replacement identity or changed receipt', async () => {
    const identity = { templateId, revision }
    const { engine } = engineFor()
    const operation = await prepareTemplateIntent(db, engine, { operation: { operation: 'install', ...identity } })
    const installed = await createDesktopTemplateServer({ db, engine, initializeImportedSetup: async () => ({ revision: 'setup' }), commitInstalled: input => commitDesktopTemplateInstall(db, input) }).handle(operation)
    if (!('status' in installed) || installed.status !== 'installed') throw new Error('Expected installed')
    const id = installed.coworkers[0]!.id
    await db.execute({ sql: 'UPDATE desktop_agents SET engine_agent_id=? WHERE id=?', args: ['replacement-engine', id] })
    await expect(readTemplateInstallIntent(db, identity)).rejects.toMatchObject({ status: 409 })
    await db.execute({ sql: 'DELETE FROM desktop_agents WHERE id=?', args: [id] })
    expect(await readTemplateInstallIntent(db, identity)).toMatchObject({ status: 'installed', coworkers: [] })
    await db.execute({ sql: 'UPDATE desktop_template_requests SET fingerprint=? WHERE request_id=?', args: ['changed', installed.requestId] })
    await expect(readTemplateInstallIntent(db, identity)).rejects.toMatchObject({ status: 409 })
})

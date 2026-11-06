import { mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createClient, type Client } from '@libsql/client'
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from 'vitest'
import type { DesktopRuntime } from '../runtime'
import { createDesktopTemplateEngine } from '../../../../../engine/src/desktop/templates/service'
import { readPortableArchive } from '../../../../../engine/src/desktop/templates/portable-package'
import { prepareSkillHelperFixture } from '../../../../../engine/src/desktop/skill-publication.test-support'
import { desktopServicesSchema } from '../services/schema'
import { serviceSkillMigrationSql } from '../services/skill-journal'
import { initializeDesktopTemplates } from '../templates/schema'
import { ensureDesktopCoworkerShareSchema } from './schema'
import { ingestDesktopCoworkerShareArchive, openDesktopCoworkerShareBinding, readCurrentDesktopCoworkerShareSource } from './binding'

const fixture = vi.hoisted(() => ({ db: null as unknown as Client, runtime: null as unknown as DesktopRuntime, send: null as unknown as (path: string,init: RequestInit) => Promise<unknown> }))
vi.mock('../database', () => ({ openDesktopDatabase: async () => fixture.db }))
vi.mock('../runtime', async importOriginal => ({ ...await importOriginal<typeof import('../runtime')>(), readDesktopRuntime: async () => fixture.runtime }))
vi.mock('@/lib/engine/client', () => ({ request: async (_engine: unknown,path: string,init: RequestInit,parse: (value: unknown) => unknown) => parse(await fixture.send(path,init)) }))
vi.mock('../coworker-delete', () => ({ assertCoworkerNotDeleting: async () => {} }))

const sourceId = '11111111-1111-4111-8111-111111111111'
const boxId = '44444444-4444-4444-8444-444444444444'
let directory = '', engineRoot = '', dbPath = ''
let helper: Awaited<ReturnType<typeof prepareSkillHelperFixture>>
const previousHelper = process.env.RERUN_DESKTOP_RENAME_HELPER
beforeAll(async () => { helper = await prepareSkillHelperFixture(); process.env.RERUN_DESKTOP_RENAME_HELPER = helper.path })
afterAll(async () => { if (previousHelper === undefined) delete process.env.RERUN_DESKTOP_RENAME_HELPER; else process.env.RERUN_DESKTOP_RENAME_HELPER = previousHelper; await helper.close() })
beforeEach(async () => {
    vi.stubEnv('RERUN_DATA_DIR','');vi.stubEnv('RERUN_HUB_BASE_URL','');vi.stubEnv('RERUN_API_KEY','')
    directory = await realpath(await mkdtemp(join(tmpdir(),'rerun-share-binding-')))
    engineRoot = join(directory,'workspaces','1','engine'); dbPath = join(directory,'app.db')
    await mkdir(join(engineRoot,'agents','source','workspace'),{ recursive: true })
    fixture.runtime = { protocolVersion: 1,buildId: 'test',launchNonce: 'test-launch',workspaceId: 1,dataRoot: directory,engineRoot,app: { origin: 'http://127.0.0.1:31111',sessionToken: 't'.repeat(32) },engine: { origin: 'http://127.0.0.1:32222',apiKey: 'test-only' } }
    fixture.db = createClient({ url: `file:${dbPath}` })
    await fixture.db.executeMultiple(`
        CREATE TABLE desktop_agents (id TEXT PRIMARY KEY,workspace_id INTEGER NOT NULL,engine_agent_id TEXT NOT NULL UNIQUE,name TEXT NOT NULL,description TEXT NOT NULL DEFAULT '',enabled INTEGER NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
        CREATE TABLE desktop_deletions (agent_id TEXT,engine_agent_id TEXT);
        CREATE TABLE desktop_spaces (id TEXT PRIMARY KEY,workspace_id INTEGER NOT NULL,name TEXT NOT NULL,col_start INTEGER NOT NULL,row_start INTEGER NOT NULL,col_end INTEGER NOT NULL,row_end INTEGER NOT NULL);
        CREATE TABLE desktop_space_placements (agent_id TEXT PRIMARY KEY,space_id TEXT NOT NULL,col INTEGER NOT NULL,row INTEGER NOT NULL);
        CREATE TABLE desktop_board_state (workspace_id INTEGER PRIMARY KEY,revision INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE desktop_duplicates (request_id TEXT PRIMARY KEY,source_id TEXT,agent_id TEXT,name TEXT,handle TEXT,board_col INTEGER,board_row INTEGER,completed INTEGER,space_id TEXT);
        CREATE TABLE desktop_creations (request_id TEXT PRIMARY KEY,agent_id TEXT,space_id TEXT,board_col INTEGER,board_row INTEGER,phase TEXT);
    `)
    await fixture.db.executeMultiple(desktopServicesSchema); await fixture.db.executeMultiple(serviceSkillMigrationSql)
    await initializeDesktopTemplates(fixture.db); await ensureDesktopCoworkerShareSchema(fixture.db)
    await fixture.db.execute({ sql: 'INSERT INTO desktop_agents VALUES(?,1,?,?,?,?,?,?)',args: [sourceId,'source','Ada','Notes',1,'2026-11-06T00:00:00Z','2026-11-06T00:00:00Z'] })
    await fixture.db.execute({ sql: 'INSERT INTO desktop_spaces VALUES(?,1,?,0,0,30,30)',args: [boxId,'Box'] })
    await fixture.db.execute('INSERT INTO desktop_board_state VALUES(1,0)')
    const folder = join(engineRoot,'agents','source')
    await writeFile(join(folder,'SOUL.md'),'Keep the notes.')
    await writeFile(join(folder,'config.json'),JSON.stringify({ name: 'source',displayName: 'Ada',description: 'Notes',enabled: true,kind: 'user',ephemeral: false,tools: {},mcpServers: [],selfImprovement: {},setup: { required: false,completedAt: null,sessionId: null },connectionId: 'PRIVATE_CONNECTION' }))
    await writeFile(join(folder,'workspace','notes.txt'),'A portable note.')
    const names = new Map<string,string>()
    const engine = createDesktopTemplateEngine({ dataRoot: engineRoot,agentsRoot: join(engineRoot,'agents') },{ get: async id => names.has(id) ? { name: names.get(id)! } : null,insert: async (id,name) => { names.set(id,name) } })
    fixture.send = async (path,init) => {
        if (init.method === 'GET' && path.startsWith('/desktop/templates/')) { const url = new URL(path,'http://fixture'); return engine.detail(decodeURIComponent(url.pathname.split('/').pop()!),url.searchParams.get('revision') ?? undefined) }
        if (path === '/desktop/templates/install') return engine.install(JSON.parse(String(init.body)))
        if (/^\/agents\/[^/]+\/setup\/import$/.test(path)) return { revision: 'b'.repeat(64) }
        throw new Error(`Unexpected fixture request: ${path}`)
    }
})
afterEach(async () => { fixture.db.close(); await rm(directory,{ recursive: true,force: true }); vi.restoreAllMocks();vi.unstubAllEnvs() })

test('production capture uses canonical confinement, omits credentials/history, and describes unsupported memory/database truthfully', async () => {
    const folder = join(engineRoot,'agents','source')
    for (const name of ['memory','data','sessions']) await mkdir(join(folder,name))
    await writeFile(join(folder,'.env'),'KEY=SECRET_ENV')
    await writeFile(join(folder,'memory','note.md'),'SECRET_MEMORY')
    await writeFile(join(folder,'data','agent.db'),'SECRET_DATABASE')
    await writeFile(join(folder,'sessions','chat.json'),'SECRET_HISTORY')
    const runtime = fixture.runtime, binding = await openDesktopCoworkerShareBinding(runtime,sourceId)
    const source = await binding.source(1,sourceId)
    expect(source.members.map(member => member.path)).toEqual(expect.arrayContaining(['SOUL.md','config.json','workspace/notes.txt']))
    expect(source.members.some(member => /^(?:memory|data|sessions)\//.test(member.path) || member.path === '.env')).toBe(false)
    const plan = binding.service.plan(source)
    expect(plan.sourceRevision).toBe(source.revision)
    expect(plan.unavailable).toMatchObject({ memories: expect.stringContaining('unavailable'),database: expect.stringContaining('unavailable') })
    await expect(binding.service.review({ workspaceId: 1,agentId: sourceId,sourceRevision: source.revision,requestId: 'unsupported',include: { memories: true,database: false,files: false } },source)).rejects.toMatchObject({ status: 409 })
    await expect(readCurrentDesktopCoworkerShareSource(runtime,fixture.db,2,sourceId)).rejects.toMatchObject({ status: 404 })
    fixture.runtime = { ...runtime,launchNonce: 'replacement' }
    await expect(binding.source(1,sourceId)).rejects.toMatchObject({ status: 409 })
})

test('real canonical package/install receipts survive a lost share ACK and file DB reopen without another coworker', async () => {
    const runtime = fixture.runtime, binding = await openDesktopCoworkerShareBinding(runtime,sourceId)
    const source = await binding.source(1,sourceId), include = { memories: false,database: false,files: true }
    const review = await binding.service.review({ workspaceId: 1,agentId: sourceId,sourceRevision: source.revision,requestId: 'review',include },source)
    const exported = await binding.service.export({ workspaceId: 1,agentId: sourceId,sourceRevision: source.revision,requestId: 'export',include,reviewId: review.reviewId,expectedDigest: review.manifest.contentDigest },source)
    const downloaded = await binding.service.download(exported.manifest.packageKey)
    const archive = await readPortableArchive(downloaded.bytes)
    expect(archive.members.some(member => member.bytes.includes(Buffer.from('PRIVATE_CONNECTION')))).toBe(false)
    expect(await ingestDesktopCoworkerShareArchive(runtime,downloaded.bytes)).toEqual({ snapshotId: exported.manifest.packageKey })
    const input = { requestId: 'import-once',snapshotId: exported.manifest.packageKey,expectedDigest: exported.manifest.contentDigest,targetWorkspaceId: 1 }
    vi.spyOn(binding.store,'settleImport').mockRejectedValueOnce(new Error('Lost share acknowledgement after canonical commit'))
    expect(await binding.service.import(input)).toMatchObject({ status: 'uncertain',recoverable: true })
    expect((await fixture.db.execute('SELECT COUNT(*) AS count FROM desktop_agents')).rows[0]!.count).toBe(2)
    expect(await binding.service.import({ ...input,requestId: 'fresh-nonce' })).toMatchObject({ status: 'uncertain' })
    fixture.db.close(); fixture.db = createClient({ url: `file:${dbPath}` })
    fixture.runtime = { ...runtime,app: { ...runtime.app,origin: 'http://127.0.0.1:34444' } }
    const reopened = await openDesktopCoworkerShareBinding(fixture.runtime,'portable-import')
    const result = await reopened.service.import(input)
    expect(result).toMatchObject({ status: 'imported',importedAgentId: expect.any(String) })
    expect(await reopened.service.import(input)).toEqual(result)
    const rows = (await fixture.db.execute({ sql: 'SELECT id,engine_agent_id,enabled FROM desktop_agents WHERE id != ?',args: [sourceId] })).rows
    expect(rows).toHaveLength(1); expect(rows[0]!.id).toBe(result.importedAgentId); expect(rows[0]!.enabled).toBe(0)
    const installed = join(engineRoot,'agents',String(rows[0]!.engine_agent_id))
    expect(await readFile(join(installed,'workspace','notes.txt'),'utf8')).toBe('A portable note.')
    expect(JSON.parse(await readFile(join(installed,'config.json'),'utf8')).enabled).toBe(false)
    expect((await readdir(join(engineRoot,'agents'))).filter(name => name.startsWith('i'))).toHaveLength(1)
    expect((await fixture.db.execute("SELECT COUNT(*) AS count FROM desktop_template_requests WHERE operation='install'")).rows[0]!.count).toBe(1)
})

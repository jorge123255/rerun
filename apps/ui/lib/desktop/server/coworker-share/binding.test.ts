import { mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createClient, type Client } from '@libsql/client'
import { afterAll, afterEach, beforeAll, beforeEach, expect, test as baseTest, vi } from 'vitest'
import type { DesktopRuntime } from '../runtime'
import { createDesktopTemplateEngine } from '../../../../../engine/src/desktop/templates/service'
import { readPortableArchive } from '../../../../../engine/src/desktop/templates/portable-package'
import { renderMemoryMarkdown, serializeMemoryNote } from '../../../../../engine/src/desktop/coworker-share-memory/serialize'
import { captureScopedPrivateDatabase } from '../../../../../engine/src/desktop/coworker-share-database/scoped'
import { PORTABLE_DATABASE_MEMBER } from '../../../../../engine/src/desktop/coworker-share-database/member'
import { listViews } from '../../../../../engine/src/db/tableViews'
import { prepareSkillHelperFixture } from '../../../../../engine/src/desktop/skill-publication.test-support'
import { desktopServicesSchema } from '../services/schema'
import { serviceSkillMigrationSql } from '../services/skill-journal'
import { initializeDesktopTemplates } from '../templates/schema'
import { initializeDesktopRound45 } from '../round45-schema'
import { initializeDesktopRound47 } from '../round47-schema'
import { initializeDesktopRound55 } from '../round55-schema'
import { initializeDesktopRound56 } from '../round56-schema'
import { initializeDesktopRound52 } from '../round52-schema'
import { ensureDesktopCoworkerShareSchema } from './schema'
import { ingestDesktopCoworkerShareArchive, openDesktopCoworkerShareBinding, readCurrentDesktopCoworkerShareSource } from './binding'

const fixture = vi.hoisted(() => ({ db: null as unknown as Client, runtime: null as unknown as DesktopRuntime, send: null as unknown as (path: string,init: RequestInit) => Promise<unknown> }))
vi.mock('../database', () => ({ openDesktopDatabase: async () => fixture.db }))
vi.mock('../runtime', async importOriginal => ({ ...await importOriginal<typeof import('../runtime')>(), readDesktopRuntime: async () => fixture.runtime }))
vi.mock('@/lib/engine/client', () => ({ request: async (_engine: unknown,path: string,init: RequestInit,parse: (value: unknown) => unknown) => parse(await fixture.send(path,init)) }))
vi.mock('../coworker-delete', () => ({ assertCoworkerNotDeleting: async () => {} }))

const sourceId = '11111111-1111-4111-8111-111111111111'
const boxId = '44444444-4444-4444-8444-444444444444'
const test = baseTest.skipIf(process.platform !== 'darwin')
let directory = '', engineRoot = '', dbPath = ''
let helper: Awaited<ReturnType<typeof prepareSkillHelperFixture>>
const previousHelper = process.env.RERUN_DESKTOP_RENAME_HELPER
beforeAll(async () => { if (process.platform !== 'darwin') return; helper = await prepareSkillHelperFixture(); process.env.RERUN_DESKTOP_RENAME_HELPER = helper.path })
afterAll(async () => { if (process.platform !== 'darwin') return; if (previousHelper === undefined) delete process.env.RERUN_DESKTOP_RENAME_HELPER; else process.env.RERUN_DESKTOP_RENAME_HELPER = previousHelper; await helper.close() })
beforeEach(async () => {
    vi.stubEnv('RERUN_DATA_DIR','');vi.stubEnv('RERUN_HUB_BASE_URL','');vi.stubEnv('RERUN_API_KEY','')
    directory = await realpath(await mkdtemp(join(tmpdir(),'rerun-share-binding-')))
    engineRoot = join(directory,'workspaces','1','engine'); dbPath = join(directory,'app.db')
    await mkdir(join(engineRoot,'agents','source','workspace'),{ recursive: true })
    fixture.runtime = { protocolVersion: 1,buildId: 'test',launchNonce: 'test-launch',workspaceId: 1,dataRoot: directory,engineRoot,app: { origin: 'http://127.0.0.1:31111',sessionToken: 't'.repeat(32) },engine: { origin: 'http://127.0.0.1:32222',apiKey: 'test-only' } }
    fixture.db = createClient({ url: `file:${dbPath}` })
    await fixture.db.executeMultiple(`
        CREATE TABLE desktop_schema_migrations (version INTEGER PRIMARY KEY,id TEXT NOT NULL);
        CREATE TABLE desktop_agents (id TEXT PRIMARY KEY,workspace_id INTEGER NOT NULL,engine_agent_id TEXT NOT NULL UNIQUE,name TEXT NOT NULL,description TEXT NOT NULL DEFAULT '',enabled INTEGER NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
        CREATE TABLE desktop_deletions (agent_id TEXT,engine_agent_id TEXT);
        CREATE TABLE desktop_spaces (id TEXT PRIMARY KEY,workspace_id INTEGER NOT NULL,name TEXT NOT NULL,col_start INTEGER NOT NULL,row_start INTEGER NOT NULL,col_end INTEGER NOT NULL,row_end INTEGER NOT NULL);
        CREATE TABLE desktop_space_placements (agent_id TEXT PRIMARY KEY,space_id TEXT NOT NULL,col INTEGER NOT NULL,row INTEGER NOT NULL);
        CREATE TABLE desktop_board_state (workspace_id INTEGER PRIMARY KEY,revision INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE desktop_duplicates (request_id TEXT PRIMARY KEY,source_id TEXT,agent_id TEXT,name TEXT,handle TEXT,board_col INTEGER,board_row INTEGER,completed INTEGER,space_id TEXT);
        CREATE TABLE desktop_creations (request_id TEXT PRIMARY KEY,agent_id TEXT,space_id TEXT,board_col INTEGER,board_row INTEGER,phase TEXT);
    `)
    await fixture.db.executeMultiple(desktopServicesSchema); await fixture.db.executeMultiple(serviceSkillMigrationSql)
    await initializeDesktopRound45(fixture.db)
    await initializeDesktopRound47(fixture.db)
    await initializeDesktopRound52(fixture.db)
    await initializeDesktopRound55(fixture.db)
    await initializeDesktopRound56(fixture.db)
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

const noteBytes = (id = 'note', content = 'Remember the project conventions.') => Buffer.from(renderMemoryMarkdown(serializeMemoryNote({ id, content, kind: 'preference', tags: ['project'], createdAt: '2026-01-02T03:04:05Z' })))

test('production capture publishes exact canonical memory counts; database, credentials, history and indexes remain excluded', async () => {
    const folder = join(engineRoot,'agents','source')
    for (const name of ['memory','data','sessions']) await mkdir(join(folder,name))
    await writeFile(join(folder,'.env'),'KEY=SECRET_ENV')
    await writeFile(join(folder,'memory','note.md'),noteBytes())
    await writeFile(join(folder,'memory','recall.md'),'PRIVATE_RECALL')
    await writeFile(join(folder,'memory','.RERUN-private.md'),'PRIVATE_METADATA')
    await writeFile(join(folder,'memory','index.sqlite'),'PRIVATE_INDEX')
    await writeFile(join(folder,'data','agent.db'),'SECRET_DATABASE')
    await writeFile(join(folder,'sessions','chat.json'),'SECRET_HISTORY')
    const runtime = fixture.runtime, binding = await openDesktopCoworkerShareBinding(runtime,sourceId)
    const source = await binding.source(1,sourceId)
    expect(source.members.map(member => member.path)).toEqual(expect.arrayContaining(['SOUL.md','config.json','workspace/notes.txt']))
    expect(source.members.filter(member => member.path.startsWith('memory/')).map(member => member.path)).toEqual(['memory/note.md'])
    expect(source.members.some(member => /^(?:data|sessions)\//.test(member.path) || member.path === '.env')).toBe(false)
    const plan = binding.service.plan(source)
    expect(plan.sourceRevision).toBe(source.revision)
    expect(plan.unavailable).toEqual({ database: expect.stringContaining('safely included') })
    expect(plan.memoryPreview).toMatchObject({ available: true, contents: { count: 1, bytes: noteBytes().length }, digest: expect.stringMatching(/^[a-f0-9]{64}$/) })
    await expect(binding.service.review({ workspaceId: 1,agentId: sourceId,sourceRevision: source.revision,requestId: 'unsupported',include: { memories: false,database: true,files: false } },source)).rejects.toMatchObject({ status: 409 })
    const omitted = await binding.service.review({ workspaceId: 1,agentId: sourceId,sourceRevision: source.revision,requestId: 'default-off',include: { memories: false,database: false,files: false } },source)
    expect(omitted.manifest.coworkers[0]!.members.some(member => member.path.startsWith('memory/'))).toBe(false)
    await writeFile(join(folder,'memory','note.md'),noteBytes('note','Changed after review.'))
    expect((await binding.source(1,sourceId)).revision).not.toBe(source.revision)
    await expect(binding.service.review({ workspaceId: 1,agentId: sourceId,sourceRevision: source.revision,requestId: 'stale',include: { memories: true,database: false,files: false } },() => binding.source(1,sourceId))).rejects.toMatchObject({ status: 409 })
    await expect(readCurrentDesktopCoworkerShareSource(runtime,fixture.db,2,sourceId)).rejects.toMatchObject({ status: 404 })
    fixture.runtime = { ...runtime,launchNonce: 'replacement' }
    await expect(binding.source(1,sourceId)).rejects.toMatchObject({ status: 409 })
})

test('portable archives carry only app and variable requirements from the source coworker’s Vault', async () => {
    const runtime = fixture.runtime
    const binding = await openDesktopCoworkerShareBinding(runtime, sourceId)
    const original = await binding.source(1, sourceId)
    await fixture.db.executeMultiple(`
        INSERT INTO desktop_vault_mcp_servers(id,name,url,revision,credential_revision,sealed,shared_with_all,catalog_slug,catalog_method,catalog_name)
        VALUES ('PRIVATE_ITEM','PRIVATE_SERVER','https://private.example/mcp','rev','rev','PRIVATE_TOKEN',0,'linear','oauth','PRIVATE_LABEL'),
               ('other','OTHER_SERVER','https://other.example/mcp','rev','rev',NULL,0,'slack','oauth','Slack');
        INSERT INTO desktop_vault_secrets(id,name,variable,revision,value_revision,sealed,shared_with_all)
        VALUES ('SECRET_ITEM','SECRET_LABEL','TeamKey','rev','rev','SECRET_VALUE',1),
               ('detached','Hidden name','HIDDEN_KEY','rev','rev','SECRET_VALUE',0);
    `)
    await fixture.db.execute({ sql: "INSERT INTO desktop_vault_mcp_attachments VALUES('PRIVATE_ITEM',?)", args: [sourceId] })
    const source = await binding.source(1, sourceId)
    expect(source.revision).not.toBe(original.revision)
    expect(source.appSlugs).toEqual(['linear'])
    expect(source.envKeys).toEqual(['TeamKey'])

    const common = { workspaceId: 1, agentId: sourceId, sourceRevision: source.revision }
    const include = { memories: false, database: false, files: false }
    const review = await binding.service.review({ ...common, requestId: 'vault-review', include }, source)
    const exported = await binding.service.export({
        ...common, requestId: 'vault-export', include, reviewId: review.reviewId, expectedDigest: review.manifest.contentDigest,
    }, source)
    const { bytes } = await binding.service.download(exported.manifest.packageKey)
    const { manifest, members } = await readPortableArchive(bytes)
    expect(manifest.coworkers[0]!.requirements).toEqual([
        { kind: 'service-reconnect', name: 'linear', detail: 'Connect this app locally after installation.' },
        { kind: 'environment-key', name: 'TeamKey' },
    ])
    const portable = JSON.stringify(manifest) + members.map(member => member.bytes.toString('utf8')).join('')
    expect(portable).not.toMatch(/PRIVATE_|SECRET_|private\.example|HIDDEN_KEY|OTHER_SERVER|"slack"/)
    await ingestDesktopCoworkerShareArchive(runtime, bytes)
    const imported = await binding.service.import({
        requestId: 'vault-import', snapshotId: manifest.packageKey, expectedDigest: manifest.contentDigest, targetWorkspaceId: 1,
    })
    expect(imported).toMatchObject({ status: 'imported' })
    const [target] = (await fixture.db.execute('SELECT engine_agent_id,enabled FROM desktop_agents WHERE id != ?', [sourceId])).rows
    expect(target?.enabled).toBe(0)
    const copied = join(engineRoot, 'agents', String(target?.engine_agent_id))
    const requirements = JSON.parse(await readFile(join(copied, '.desktop-template-requirements.json'), 'utf8'))
    expect(requirements.requirements.map(({ name }: { name: string }) => name).sort()).toEqual(['TeamKey', 'linear'])
    expect((await fixture.db.execute('SELECT agent_id FROM desktop_vault_mcp_attachments')).rows).toEqual([{ agent_id: sourceId }])

    await fixture.db.execute("DELETE FROM desktop_vault_mcp_attachments WHERE item_id='PRIVATE_ITEM'")
    expect((await binding.source(1, sourceId)).appSlugs).toEqual([])
})

test('real canonical package/install receipts survive a lost share ACK and file DB reopen without another coworker', async () => {
    await mkdir(join(engineRoot,'agents','source','memory'))
    await writeFile(join(engineRoot,'agents','source','memory','note.md'),noteBytes())
    const runtime = fixture.runtime, binding = await openDesktopCoworkerShareBinding(runtime,sourceId)
    const source = await binding.source(1,sourceId), include = { memories: true,database: false,files: true }
    const review = await binding.service.review({ workspaceId: 1,agentId: sourceId,sourceRevision: source.revision,requestId: 'review',include },source)
    const exported = await binding.service.export({ workspaceId: 1,agentId: sourceId,sourceRevision: source.revision,requestId: 'export',include,reviewId: review.reviewId,expectedDigest: review.manifest.contentDigest },source)
    const downloaded = await binding.service.download(exported.manifest.packageKey)
    const archive = await readPortableArchive(downloaded.bytes)
    expect(archive.members.find(member => member.path === 'memory/note.md')?.bytes).toEqual(noteBytes())
    expect(exported.manifest.excludedCategories).not.toContain('memory')
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
    expect(await readFile(join(installed,'memory','note.md'))).toEqual(noteBytes())
    expect(await readdir(join(installed,'memory'))).toEqual(['note.md'])
    expect(JSON.parse(await readFile(join(installed,'config.json'),'utf8')).enabled).toBe(false)
    expect((await readdir(join(engineRoot,'agents'))).filter(name => name.startsWith('i'))).toHaveLength(1)
    expect((await fixture.db.execute("SELECT COUNT(*) AS count FROM desktop_template_requests WHERE operation='install'")).rows[0]!.count).toBe(1)
})


test('exports only opted-in logical tables and restores the same disabled database after an interrupted roster commit', async () => {
    const privateFolder = join(engineRoot, 'agents', 'source', 'data')
    await mkdir(privateFolder)
    const sourcePath = join(privateFolder, 'agent.db')
    const sourceDb = createClient({ url: `file:${sourcePath}` })
    try {
        await sourceDb.executeMultiple(`
            CREATE TABLE notes (id INTEGER PRIMARY KEY, title TEXT, attachment BLOB);
            INSERT INTO notes VALUES (1,'Original café',X'00FF'), (2,'Other row',NULL);
            CREATE TABLE _rerun_internal (marker TEXT);
            INSERT INTO _rerun_internal VALUES ('Do not share this');
            CREATE TABLE _rerun_views (id TEXT PRIMARY KEY,table_name TEXT NOT NULL,name TEXT NOT NULL,position INTEGER NOT NULL,config TEXT NOT NULL,updated_at TEXT NOT NULL);
            INSERT INTO _rerun_views VALUES ('saved-view','notes','Saved',3,'{"layout":"table"}','2026-01-01');
        `)
    } finally { sourceDb.close() }
    const original = await readFile(sourcePath)
    const engine = fixture.send
    fixture.send = (path, init) => path === '/desktop/coworker-share-database/capture'
        ? captureScopedPrivateDatabase({ ...JSON.parse(String(init.body)), engineRoot, assertCurrent: async () => {} })
        : engine(path, init)
    const runtime = fixture.runtime
    const binding = await openDesktopCoworkerShareBinding(runtime, sourceId)
    const first = await binding.source(1, sourceId)
    const second = await binding.source(1, sourceId)
    expect(second.revision).toBe(first.revision)
    expect(binding.service.plan(first).databasePreview).toMatchObject({ available: true, contents: { count: 1 }, viewCount: 1 })
    const common = { workspaceId: 1, agentId: sourceId, sourceRevision: first.revision }
    const include = { memories: false, database: true, files: false }
    const off = await binding.service.review({ ...common, requestId: 'db-off', include: { ...include, database: false } }, first)
    expect(off.manifest.coworkers[0]!.members.map(member => member.path)).not.toContain(PORTABLE_DATABASE_MEMBER)
    const review = await binding.service.review({ ...common, requestId: 'db-review', include }, first)
    const exported = await binding.service.export({ ...common, requestId: 'db-export', include, reviewId: review.reviewId, expectedDigest: review.manifest.contentDigest }, second)
    const archive = await binding.service.download(exported.manifest.packageKey)
    const { members } = await readPortableArchive(archive.bytes)
    expect(members.map(member => member.path)).toContain(PORTABLE_DATABASE_MEMBER)
    expect(members.map(member => member.path)).not.toContain('data/agent.db')
    expect(members.find(member => member.path === PORTABLE_DATABASE_MEMBER)!.bytes.toString()).not.toContain('Do not share this')
    expect(await readFile(sourcePath)).toEqual(original)

    const input = { requestId: 'db-import', snapshotId: exported.manifest.packageKey, expectedDigest: exported.manifest.contentDigest, targetWorkspaceId: 1 }
    await fixture.db.execute("CREATE TRIGGER fixture_stop_roster BEFORE INSERT ON desktop_agents WHEN NEW.engine_agent_id != 'source' BEGIN SELECT RAISE(ABORT,'fixture stop after private database publication'); END")
    expect(await binding.service.import(input)).toMatchObject({ status: 'uncertain', recoverable: true })
    expect((await fixture.db.execute('SELECT count(*) AS n FROM desktop_agents')).rows[0]!.n).toBe(1)
    const folders = (await readdir(join(engineRoot, 'agents'))).filter(name => name !== 'source')
    expect(folders).toHaveLength(1)
    const installed = join(engineRoot, 'agents', folders[0]!, 'data', 'agent.db')
    const staged = await readFile(installed)
    await fixture.db.execute('DROP TRIGGER fixture_stop_roster')
    fixture.db.close()
    fixture.db = createClient({ url: `file:${dbPath}` })
    const reopened = await openDesktopCoworkerShareBinding(runtime, 'portable-import')
    expect(await reopened.service.import({ ...input, requestId: 'different-attempt' })).toMatchObject({ status: 'uncertain' })
    const result = await reopened.service.import(input)
    expect(result).toMatchObject({ status: 'imported', importedAgentId: expect.any(String) })
    const roster = (await fixture.db.execute("SELECT engine_agent_id,enabled FROM desktop_agents WHERE engine_agent_id != 'source'")).rows
    expect(roster).toEqual([{ engine_agent_id: folders[0], enabled: 0 }])
    expect(await readFile(installed)).toEqual(staged)
    const target = createClient({ url: `file:${installed}` })
    try {
        const { rows } = await target.execute('SELECT id,title,hex(attachment) AS bytes FROM notes ORDER BY id')
        expect(rows).toEqual([{ id: 1, title: 'Original café', bytes: '00FF' }, { id: 2, title: 'Other row', bytes: '' }])
        expect(await listViews(target, 'notes')).toMatchObject([{ id: 'saved-view', name: 'Saved', position: 3, layout: 'table' }])
        expect((await target.execute("SELECT name FROM sqlite_master WHERE name='_rerun_internal'")).rows).toHaveLength(0)
    } finally { target.close() }
}, 20_000)

test('combined portable Share preserves opted-in memory, private row, saved view and file across receipt restart; opt-outs and credential sentinel stay out', async () => {
    const folder = join(engineRoot, 'agents', 'source')
    const sentinel = 'SYNTHETIC_CREDENTIAL_SENTINEL_NEVER_EXPORT_20261110'
    await mkdir(join(folder, 'memory')); await mkdir(join(folder, 'data'))
    await writeFile(join(folder, '.env'), `ANTHROPIC_API_KEY=${sentinel}\n`)
    await writeFile(join(folder, 'memory', 'note.md'), noteBytes())
    const sourceDb = createClient({ url: `file:${join(folder, 'data', 'agent.db')}` })
    try {
        await sourceDb.executeMultiple(`CREATE TABLE notes(id INTEGER PRIMARY KEY,title TEXT);
            INSERT INTO notes VALUES(1,'Exact portable café row');
            CREATE TABLE _rerun_internal(marker TEXT);
            INSERT INTO _rerun_internal VALUES('SYNTHETIC_CREDENTIAL_SENTINEL_NEVER_EXPORT_20261110');
            CREATE TABLE _rerun_views(id TEXT PRIMARY KEY,table_name TEXT NOT NULL,name TEXT NOT NULL,position INTEGER NOT NULL,config TEXT NOT NULL,updated_at TEXT NOT NULL);
            INSERT INTO _rerun_views VALUES('portable-view','notes','Portable review',2,'{"layout":"table"}','2026-11-10');`)
    } finally { sourceDb.close() }
    const send = fixture.send
    fixture.send = (path, init) => path === '/desktop/coworker-share-database/capture'
        ? captureScopedPrivateDatabase({ ...JSON.parse(String(init.body)), engineRoot, assertCurrent: async () => {} }) : send(path, init)
    const runtime = fixture.runtime, binding = await openDesktopCoworkerShareBinding(runtime, sourceId), source = await binding.source(1, sourceId)
    const plan = binding.service.plan(source)
    expect(plan.memoryPreview).toMatchObject({ available: true, contents: { count: 1, bytes: noteBytes().length } })
    expect(plan.databasePreview).toMatchObject({ available: true, contents: { count: 1 }, viewCount: 1 })
    expect(plan.contents.files).toEqual({ count: 1, bytes: Buffer.byteLength('A portable note.') })
    const common = { workspaceId: 1, agentId: sourceId, sourceRevision: source.revision }
    const off = await binding.service.review({ ...common, requestId: 'combined-off', include: { memories: false, database: false, files: false } }, source)
    expect(off.manifest.coworkers[0]!.members.some(member => /^(memory|workspace)\//.test(member.path) || member.path === PORTABLE_DATABASE_MEMBER)).toBe(false)
    expect(off.manifest.excludedCategories).toEqual(expect.arrayContaining(['memory', 'private-memory', 'database', 'credentials']))
    const include = { memories: true, database: true, files: true }
    const review = await binding.service.review({ ...common, requestId: 'combined-review', include }, source)
    const exported = await binding.service.export({ ...common, requestId: 'combined-export', include, reviewId: review.reviewId, expectedDigest: review.manifest.contentDigest }, source)
    expect(exported.manifest).toEqual(review.manifest)
    const downloaded = await binding.service.download(exported.manifest.packageKey), archive = await readPortableArchive(downloaded.bytes)
    expect(archive.members.find(member => member.path === 'memory/note.md')?.bytes).toEqual(noteBytes())
    expect(archive.members.find(member => member.path === 'workspace/notes.txt')?.bytes).toEqual(Buffer.from('A portable note.'))
    expect(archive.members.map(member => member.path)).toContain(PORTABLE_DATABASE_MEMBER)
    for (const member of archive.members) {
        expect(member.bytes.toString()).not.toContain(sentinel)
        expect(member.path).not.toMatch(/(?:^|\/)\.env$|data\/agent\.db$/)
        const reviewed = review.manifest.coworkers[0]!.members.find(row => row.path === member.path)
        expect(reviewed?.bytes).toBe(member.bytes.length)
    }
    expect(review.manifest.excludedCategories).toContain('credentials')
    const input = { requestId: 'combined-import', snapshotId: exported.manifest.packageKey, expectedDigest: exported.manifest.contentDigest, targetWorkspaceId: 1 }
    const first = await binding.service.import(input)
    expect(first).toMatchObject({ status: 'imported', importedAgentId: expect.any(String) })
    fixture.db.close(); fixture.db = createClient({ url: `file:${dbPath}` })
    const reopened = await openDesktopCoworkerShareBinding(runtime, 'portable-import')
    expect(await reopened.service.import(input)).toEqual(first)
    const rows = (await fixture.db.execute({ sql: 'SELECT id,engine_agent_id,enabled FROM desktop_agents WHERE id!=?', args: [sourceId] })).rows
    expect(rows).toHaveLength(1); expect(rows[0]!.enabled).toBe(0); expect(rows[0]!.id).not.toBe(sourceId); expect(rows[0]!.engine_agent_id).not.toBe('source')
    const installed = join(engineRoot, 'agents', String(rows[0]!.engine_agent_id))
    expect(await readFile(join(installed, 'memory', 'note.md'))).toEqual(noteBytes())
    expect(await readFile(join(installed, 'workspace', 'notes.txt'))).toEqual(Buffer.from('A portable note.'))
    const config = JSON.parse(await readFile(join(installed, 'config.json'), 'utf8'))
    expect(config.enabled).toBe(false); expect(config.connectionId ?? null).toBeNull()
    expect(Object.values(config.tools?.desktopToolGrants ?? {}).every(value => value !== true)).toBe(true)
    expect(await readdir(installed)).not.toContain('.env')
    const target = createClient({ url: `file:${join(installed, 'data', 'agent.db')}` })
    try {
        expect((await target.execute('SELECT id,title FROM notes')).rows).toEqual([{ id: 1, title: 'Exact portable café row' }])
        expect(await listViews(target, 'notes')).toMatchObject([{ id: 'portable-view', name: 'Portable review', position: 2, layout: 'table' }])
        expect((await target.execute("SELECT name FROM sqlite_master WHERE name='_rerun_internal'")).rows).toEqual([])
    } finally { target.close() }
}, 20_000)

test('lost import response recovers only the original workspace/digest/request receipt, including after completion and reopen', async () => {
    const runtime = fixture.runtime, binding = await openDesktopCoworkerShareBinding(runtime, sourceId)
    const source = await binding.source(1, sourceId), include = { memories: false, database: false, files: false }
    const common = { workspaceId: 1, agentId: sourceId, sourceRevision: source.revision, include }
    const review = await binding.service.review({ ...common, requestId: 'integrity-review' }, source)
    const exported = await binding.service.export({ ...common, requestId: 'integrity-export', reviewId: review.reviewId, expectedDigest: review.manifest.contentDigest }, source)
    const inspected = await binding.service.inspect(exported.manifest.packageKey)
    expect(inspected.importReview.manifestDigest).toBe(review.manifest.contentDigest)
    const input = { requestId: 'integrity-original', snapshotId: exported.manifest.packageKey, expectedDigest: inspected.importReview.manifestDigest, targetWorkspaceId: 1 }
    vi.spyOn(binding.store, 'settleImport').mockRejectedValueOnce(new Error('Synthetic lost response after canonical install'))
    expect(await binding.service.import(input)).toMatchObject({ status: 'uncertain', recoverable: true })
    expect(await binding.service.import({ ...input, requestId: 'integrity-alias-before' })).toMatchObject({ status: 'uncertain' })
    await expect(binding.service.import({ ...input, expectedDigest: '0'.repeat(64) })).rejects.toMatchObject({ status: 409 })
    await expect(binding.service.import({ ...input, targetWorkspaceId: 2 })).rejects.toThrow()
    fixture.db.close(); fixture.db = createClient({ url: `file:${dbPath}` })
    const reopened = await openDesktopCoworkerShareBinding(runtime, 'portable-import')
    const recovered = await reopened.service.import(input)
    expect(recovered).toMatchObject({ status: 'imported', importedAgentId: expect.any(String) })
    // Parent negative control: the old branch returned this completed receipt to a different UUID.
    expect(await reopened.service.import({ ...input, requestId: 'integrity-alias-after' })).toMatchObject({ status: 'uncertain' })
    expect(await reopened.service.import(input)).toEqual(recovered)
    const copies = (await fixture.db.execute({ sql: 'SELECT id,engine_agent_id,enabled FROM desktop_agents WHERE id!=?', args: [sourceId] })).rows
    expect(copies).toHaveLength(1); expect(copies[0]!.id).toBe(recovered.importedAgentId); expect(copies[0]!.enabled).toBe(0)
    expect((await fixture.db.execute("SELECT count(*) AS n FROM desktop_template_requests WHERE operation='install'")).rows[0]!.n).toBe(1)
    const receipts = (await fixture.db.execute("SELECT request_id,status FROM desktop_coworker_share_imports")).rows
    expect(receipts).toEqual([{ request_id: input.requestId, status: 'imported' }])
})

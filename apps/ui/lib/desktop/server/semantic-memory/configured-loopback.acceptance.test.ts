import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createClient, type Client } from '@libsql/client'
import { expect, it, vi } from 'vitest'
import { POST } from '@/app/api/desktop/internal/semantic-memory/route'
import { desktopAuxiliarySchema, desktopAuxiliaryStore } from '../auxiliary/store'

const fixture = vi.hoisted(() => ({ db: null as unknown as Client, brain: null as unknown as Client, root: '', origin: '', enabled: true, grant: true, notes: [] as any[], clear: null as null | { notesCleared(id: string): Promise<unknown> } }))
vi.mock('../database', () => ({ openDesktopDatabase: async () => fixture.db }))
vi.mock('../runtime', () => ({ readDesktopRuntime: async () => ({ workspaceId: 7, dataRoot: fixture.root, app: { origin: fixture.origin, sessionToken: 'synthetic-session' }, engine: { apiKey: 'synthetic-loopback-key' } }) }))
vi.mock('../../../../../engine/src/config/paths.js', () => ({ dataDir: () => fixture.root }))
vi.mock('../../../../../engine/src/config/env.js', () => ({ env: () => ({ RERUN_HUB_BASE_URL: fixture.origin, RERUN_API_KEY: 'synthetic-loopback-key', RERUN_LOG_LEVEL: 'silent' }) }))
vi.mock('../../../../../engine/src/desktop/policy.js', () => ({ desktopApp: () => true }))
vi.mock('../../../../../engine/src/agents/loader.js', () => ({ readAgentConfig: async () => ({ enabled: fixture.enabled, tools: { desktopToolGrants: { brain: fixture.grant } } }) }))
vi.mock('../../../../../engine/src/desktop/agent-lifecycle.js', () => ({ desktopDeletionActive: () => false, assertDesktopAgentNotDeleted: () => {} }))
vi.mock('../../../../../engine/src/desktop/memory-paths.js', () => ({ desktopMemoryPaths: async () => ({}) }))
vi.mock('../../../../../engine/src/desktop/memory-store.js', () => ({
    listDesktopMemory: async () => [fixture.notes, []], reinforceDesktopMemories: async () => {}, bindDesktopMemorySemanticClear: (value: typeof fixture.clear) => { fixture.clear = value },
    recallDesktopMemory: async (_owner: string, query: string) => fixture.notes.filter(note => note.content.toLowerCase().includes(query.toLowerCase())).map(({ path: _path, ...note }) => ({ ...note, strength: 1 })),
}))
vi.mock('../../../../../engine/src/db/brainDb.js', () => ({ getBrainDb: async () => fixture.brain }))
vi.mock('../../../../../engine/src/desktop/brain-pages-router.js', () => ({ getDesktopBrainStore: async () => ({
    listPages: async () => [{ slug: 'care' }],
    readPage: async () => ({ page: { slug: 'care', title: 'Care', type: 'offering', hash: 'a'.repeat(32), content: '## Routine\n\nCanines require daily exercise', sources: [], unconfirmed: [], links: [], updatedAt: '', updatedBy: 'user' } }),
    search: async (query: string) => ({ hits: query.toLowerCase().includes('canines') ? [{ slug: 'care', title: 'Care', type: 'offering', score: 1, passages: [{ heading: 'Routine', content: 'Canines require daily exercise' }] }] : [], related: [] }),
}) }))

it('normal configured callback and both engine bindings use loopback vectors, persist indexes, distinguish keyword fallback and revoke current workspace only', async () => {
    fixture.root = await mkdtemp(join(tmpdir(), 'configured-recall-'))
    fixture.db = createClient({ url: `file:${join(fixture.root, 'app.db')}` })
    fixture.brain = createClient({ url: `file:${join(fixture.root, 'brain.db')}` })
    const nativeFetch = globalThis.fetch
    let offline = false, providerRequests = 0
    const server = createServer(async (incoming, outgoing) => {
        try {
            const chunks: Buffer[] = []; for await (const chunk of incoming) chunks.push(Buffer.from(chunk))
            const body = Buffer.concat(chunks).toString()
            if (incoming.url === '/fixture/embeddings') {
                providerRequests++
                if (offline) { outgoing.writeHead(503).end(); return }
                const texts = JSON.parse(body).input as string[]
                const data = texts.map((text, index) => { const embedding = Array(1536).fill(0); embedding[text.includes('Canines') || text === 'Dogs need regular walks' ? 0 : 1] = 1; return { index, embedding } })
                outgoing.setHeader('content-type', 'application/json'); outgoing.end(JSON.stringify({ data })); return
            }
            if (incoming.url !== '/api/desktop/internal/semantic-memory') throw new Error('Unexpected loopback route')
            const response = await POST(new Request(fixture.origin + incoming.url, { method: 'POST', headers: { host: new URL(fixture.origin).host, authorization: String(incoming.headers.authorization ?? ''), 'content-type': 'application/json' }, body }))
            outgoing.writeHead(response.status, Object.fromEntries(response.headers)); outgoing.end(Buffer.from(await response.arrayBuffer()))
        } catch { outgoing.writeHead(500).end() }
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address() as { port: number }; fixture.origin = `http://127.0.0.1:${address.port}`
    vi.stubEnv('RERUN_DESKTOP_SECRET_KEY', 'd'.repeat(64))
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (input, init) => {
        const url = new URL(String(input))
        if (url.href === 'https://openrouter.ai/api/v1/embeddings') return nativeFetch(fixture.origin + '/fixture/embeddings', init)
        if (url.origin !== fixture.origin) throw new Error('External traffic forbidden in fixture')
        return nativeFetch(input, init)
    }))
    // Load the real engine at runtime without compiling it in the UI's TypeScript target.
    const memoryPath = resolve(import.meta.dirname, '../../../../../engine/src/desktop/semantic-memory/runtime.ts')
    const brainPath = resolve(import.meta.dirname, '../../../../../engine/src/desktop/brain-semantic/runtime.ts')
    let memory: {
        maintainSemanticDesktopMemory(owner: string, operation: 'reconcile'): Promise<unknown>
        semanticDesktopMemoryStatus(owner: string): Promise<{ indexed: number }>
        recallSemanticDesktopMemory(owner: string, query: { query: string; limit: number; includeDormant: boolean; reinforce: 'none' }): Promise<{ memories: { id: string }[] }>
        shutdownDesktopSemanticMemory(): Promise<void>
    } | undefined
    try {
        await fixture.db.executeMultiple(`CREATE TABLE desktop_agents(id TEXT PRIMARY KEY,workspace_id INTEGER,engine_agent_id TEXT,enabled INTEGER); CREATE TABLE desktop_deletions(agent_id TEXT,engine_agent_id TEXT);
            INSERT INTO desktop_agents VALUES('local-owner',1,'owner',1); INSERT INTO desktop_agents VALUES('foreign-owner',2,'foreign',1);` + desktopAuxiliarySchema)
        let credentials = desktopAuxiliaryStore(fixture.db)
        await credentials.change({ purpose: 'embedding', expectedRevision: 'unconfigured', key: 'synthetic-provider-key' })
        fixture.notes = [{ id: 'walks', content: 'Canines require daily exercise', path: '/synthetic/memory/walks.md', kind: 'fact', tags: [], createdAt: new Date().toISOString() }]
        const memoryRuntime: NonNullable<typeof memory> = await import(/* @vite-ignore */ memoryPath)
        memory = memoryRuntime
        const brainRuntime = await import(/* @vite-ignore */ brainPath)
        await brainRuntime.initializeDesktopBrainSemanticStore()
        let brain = await brainRuntime.desktopBrainSemanticIndex('owner', new AbortController().signal)
        const query = { query: 'Dogs need regular walks', limit: 5, includeDormant: false, reinforce: 'none' as const }
        await memory.maintainSemanticDesktopMemory('owner', 'reconcile')
        await vi.waitFor(async () => expect((await memory!.semanticDesktopMemoryStatus('owner')).indexed).toBe(1))
        expect(await memory.recallSemanticDesktopMemory('owner', query)).toMatchObject({ mode: 'semantic', memories: [{ id: 'walks' }] })
        await brain.reconcile(true)
        expect((await brain.search({ query: query.query })).hits[0]?.slug).toBe('care')
        expect(providerRequests).toBeGreaterThan(0)
        const foreign = await POST(new Request(fixture.origin + '/api/desktop/internal/semantic-memory', { method: 'POST', headers: { host: new URL(fixture.origin).host, authorization: 'Bearer synthetic-loopback-key' }, body: JSON.stringify({ operation: 'configuration', engineAgentId: 'foreign' }) }))
        expect(foreign.status).toBe(400)
        await memory.shutdownDesktopSemanticMemory(); vi.resetModules()
        fixture.db.close(); fixture.db = createClient({ url: `file:${join(fixture.root, 'app.db')}` }); credentials = desktopAuxiliaryStore(fixture.db)
        fixture.brain.close(); fixture.brain = createClient({ url: `file:${join(fixture.root, 'brain.db')}` })
        const reopenedMemory: NonNullable<typeof memory> = await import(/* @vite-ignore */ memoryPath)
        memory = reopenedMemory
        brain = await (await import(/* @vite-ignore */ brainPath)).desktopBrainSemanticIndex('owner', new AbortController().signal)
        expect((await memory.recallSemanticDesktopMemory('owner', query)).memories[0]?.id).toBe('walks')
        expect((await brain.search({ query: query.query })).hits[0]?.slug).toBe('care')
        offline = true
        expect(await memory.recallSemanticDesktopMemory('owner', query)).toMatchObject({ mode: 'keyword-only', memories: [] })
        expect((await memory.recallSemanticDesktopMemory('owner', { ...query, query: 'Canines' })).memories[0]?.id).toBe('walks')
        expect((await brain.search({ query: query.query })).hits).toEqual([])
        expect((await brain.search({ query: 'Canines' })).hits[0]?.slug).toBe('care')
        offline = false
        const current = await credentials.read('embedding')
        await credentials.change({ purpose: 'embedding', expectedRevision: current.revision, key: '' })
        expect(await memory.recallSemanticDesktopMemory('owner', query)).toMatchObject({ mode: 'keyword-only', memories: [] })
        fixture.notes = []; await fixture.clear!.notesCleared('owner')
        expect((await memory.recallSemanticDesktopMemory('owner', query)).memories).toEqual([])
        fixture.grant = false
        await expect(brain.search({ query: 'Canines' })).rejects.toThrow(/turned off/)
        expect(JSON.stringify(await fixture.db.execute('SELECT * FROM desktop_auxiliary_credentials'))).not.toContain('synthetic-provider-key')
    } finally {
        await memory?.shutdownDesktopSemanticMemory(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()))
        fixture.db.close(); fixture.brain.close(); await rm(fixture.root, { recursive: true, force: true }); vi.unstubAllGlobals(); vi.unstubAllEnvs()
    }
}, 30_000)

// @vitest-environment happy-dom
import { act, useRef, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createClient, type Client } from '@libsql/client'
import { afterEach, expect, it, vi } from 'vitest'
import type { ConnectionsList } from '@rerun/contracts'
import { desktopSemanticMaintainSchema, desktopSemanticRecallRequestSchema } from '@rerun/contracts'
import { GET as readAuxiliary, PATCH as saveAuxiliary } from '@/app/api/desktop/auxiliary/route'
import { GET as readMemories } from '@/app/api/desktop/agents/[agentId]/memories/route'
import { GET as readSemantic, POST as recallSemantic } from '@/app/api/desktop/coworkers/[agentId]/semantic-memory/route'
import { POST as retrySemantic } from '@/app/api/desktop/coworkers/[agentId]/semantic-memory/index/route'
import { POST as embedCallback } from '@/app/api/desktop/internal/semantic-memory/route'
import { DesktopSettings } from './DesktopSettings'
import { DesktopCoworkerMemories } from './DesktopCoworkerMemories'
import { DesktopBrainSidebar } from './brain/pages/DesktopBrainSidebar'
import type { DesktopBrainSelection } from './brain/pages/types'

// Disposable mounted path for the current embedding configuration.
// Production still posts only to https://openrouter.ai/api/v1/embeddings.
// This file's fetch stub is the only loopback substitution. Root runs it.

const LOCAL = 'local-owner'
const ENGINE = 'owner'
const CANON = 'Canines require daily exercise'
const PARAPHRASE = 'Dogs need regular walks'
const PAGE = `## Routine\n\n${CANON}`
const PROVIDER_KEY = 'synthetic-provider-key'
const providers: ConnectionsList = { connections: [], default: null }
const summary = { slug: 'care', title: 'Care', type: 'offering' as const, hash: 'a'.repeat(32), updatedAt: '2026-11-09T00:00:00.000Z', updatedBy: 'user' }
const coworker = { id: LOCAL, name: 'Care coworker', description: '', createdAt: summary.updatedAt, updatedAt: summary.updatedAt }

type FixtureNote = { id: string; content: string; path: string; kind: 'fact'; tags: string[]; createdAt: string }
type MemoryRuntime = {
    semanticDesktopMemoryStatus(owner: string): Promise<unknown>
    recallSemanticDesktopMemory(owner: string, query: { query: string; limit: number; includeDormant: boolean; reinforce: 'none' }): Promise<unknown>
    maintainSemanticDesktopMemory(owner: string, operation: 'retry' | 'reconcile'): Promise<unknown>
    shutdownDesktopSemanticMemory(): Promise<void>
}
type BrainRuntime = {
    initializeDesktopBrainSemanticStore(): Promise<void>
    desktopBrainSemanticIndex(owner: string, signal: AbortSignal): Promise<{ reconcile(force: boolean): Promise<unknown>; search(input: { query: string }): Promise<{ hits: { slug?: string }[] }> }>
}

const fixture = vi.hoisted(() => ({
    db: null as unknown as Client,
    brain: null as unknown as Client,
    root: '',
    origin: '',
    enabled: true,
    grant: true,
    notes: [] as FixtureNote[],
    clear: null as null | { notesCleared(id: string): Promise<unknown> },
    sessionToken: 'synthetic-session-token-for-offline-fixture-only',
    engineKey: 'synthetic-loopback-key',
}))

vi.mock('server-only', () => ({}))
vi.mock('@/lib/desktop/server/runtime', () => ({ readDesktopRuntime: async () => ({
    protocolVersion: 1, launchNonce: 'mounted-recall-fixture', buildId: 'fixture', workspaceId: 7, dataRoot: fixture.root,
    app: { origin: fixture.origin, sessionToken: fixture.sessionToken }, engine: { origin: fixture.origin, apiKey: fixture.engineKey },
}) }))
vi.mock('@/lib/desktop/server/database', () => ({ openDesktopDatabase: async () => fixture.db }))
vi.mock('../../../engine/src/config/paths.js', () => ({ dataDir: () => fixture.root }))
vi.mock('../../../engine/src/config/env.js', () => ({ env: () => ({ RERUN_HUB_BASE_URL: fixture.origin, RERUN_API_KEY: fixture.engineKey, RERUN_LOG_LEVEL: 'silent' }) }))
vi.mock('../../../engine/src/desktop/policy.js', () => ({ desktopApp: () => true }))
vi.mock('../../../engine/src/agents/loader.js', () => ({ readAgentConfig: async () => ({ enabled: fixture.enabled, tools: { desktopToolGrants: { brain: fixture.grant } } }) }))
vi.mock('../../../engine/src/desktop/agent-lifecycle.js', () => ({ desktopDeletionActive: () => false, assertDesktopAgentNotDeleted: () => {} }))
vi.mock('../../../engine/src/desktop/memory-paths.js', () => ({ desktopMemoryPaths: async () => ({}) }))
vi.mock('../../../engine/src/desktop/memory-store.js', () => ({
    listDesktopMemory: async () => [fixture.notes, []],
    reinforceDesktopMemories: async () => {},
    bindDesktopMemorySemanticClear: (value: typeof fixture.clear) => { fixture.clear = value },
    recallDesktopMemory: async (_owner: string, query: string) => fixture.notes.filter(note => note.content.toLowerCase().includes(query.toLowerCase())).map(({ id, content, kind, tags, createdAt }) => ({ id, content, kind, tags, createdAt, strength: 1 })),
}))
vi.mock('../../../engine/src/db/brainDb.js', () => ({ getBrainDb: async () => fixture.brain }))
vi.mock('../../../engine/src/desktop/brain-pages-router.js', () => ({ getDesktopBrainStore: async () => ({
    listPages: async () => [{ slug: 'care' }],
    readPage: async () => ({ page: { slug: 'care', title: 'Care', type: 'offering', hash: 'a'.repeat(32), content: PAGE, sources: [], unconfirmed: [], links: [], updatedAt: '', updatedBy: 'user' } }),
    search: async (query: string) => ({ hits: query.toLowerCase().includes('canines') ? [{ slug: 'care', title: 'Care', type: 'offering', score: 1, passages: [{ heading: 'Routine', content: CANON }] }] : [], related: [] }),
}) }))

let root: Root | null = null
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = null; document.body.innerHTML = '' })

function dialog() { return document.querySelector('[role="dialog"]') }
function serviceText(title: string) {
    const form = [...document.querySelectorAll('form')].find(item => item.querySelector('h2')?.textContent === title)
    if (!form) throw new Error(`Missing tool service ${title}`)
    return form.textContent ?? ''
}
function button(label: string) {
    const found = [...document.querySelectorAll('button')].find(item => item.textContent?.trim() === label)
    if (!found) throw new Error(`No button ${label}`)
    return found as HTMLButtonElement
}
async function click(label: string) { await act(async () => { button(label).click() }) }
async function typeInto(field: HTMLInputElement, value: string) {
    await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, value)
        field.dispatchEvent(new Event('input', { bubbles: true }))
    })
}
function brainPane() { return document.querySelector('[aria-label="Company Brain"]') }

it('mounts Tool services and the board, recalls a paraphrase, keeps it across a cold reopen, and publishes nothing after the key is removed', async () => {
    fixture.root = await mkdtemp(join(tmpdir(), 'mounted-recall-'))
    fixture.db = createClient({ url: `file:${join(fixture.root, 'app.db')}` })
    fixture.brain = createClient({ url: `file:${join(fixture.root, 'brain.db')}` })
    fixture.notes = [{ id: 'walks', content: CANON, path: '/synthetic/memory/walks.md', kind: 'fact', tags: [], createdAt: '2026-11-09T00:00:00.000Z' }]
    const nativeFetch = globalThis.fetch
    const embedded: { phase: string; texts: string[] }[] = []
    let providerRequests = 0, offline = false, phase = 'boot'
    let memoryRuntime: MemoryRuntime | undefined
    let brainRuntime: BrainRuntime | undefined
    const server = createServer(async (incoming, outgoing) => {
        if (incoming.headers.origin) outgoing.setHeader('access-control-allow-origin', incoming.headers.origin)
        if (incoming.method === 'OPTIONS') {
            outgoing.writeHead(204, { 'access-control-allow-methods': 'GET, POST', 'access-control-allow-headers': 'authorization, content-type' }).end()
            return
        }
        try {
            const chunks: Buffer[] = []; for await (const chunk of incoming) chunks.push(Buffer.from(chunk))
            const body = Buffer.concat(chunks).toString()
            const url = incoming.url ?? ''
            if (url === '/fixture/embeddings') {
                providerRequests += 1
                const texts = JSON.parse(body).input as string[]
                embedded.push({ phase, texts })
                if (offline) { outgoing.writeHead(503).end(); return }
                const data = texts.map((text, index) => {
                    const embedding = Array(1536).fill(0)
                    embedding[text.includes('Canines') || text === PARAPHRASE ? 0 : 1] = 1
                    return { index, embedding }
                })
                outgoing.setHeader('content-type', 'application/json')
                outgoing.end(JSON.stringify({ data }))
                return
            }
            const header = Array.isArray(incoming.headers.authorization) ? incoming.headers.authorization[0] ?? '' : incoming.headers.authorization ?? ''
            const token = header.startsWith('Bearer ') ? header.slice(7) : header
            if (token !== fixture.engineKey) { outgoing.writeHead(401, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'Unauthorized' })); return }
            if (url === '/api/desktop/internal/semantic-memory') {
                const response = await embedCallback(new Request(fixture.origin + url, { method: 'POST', headers: { host: new URL(fixture.origin).host, authorization: header, 'content-type': 'application/json' }, body }))
                outgoing.writeHead(response.status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
                outgoing.end(Buffer.from(await response.arrayBuffer()))
                return
            }
            const match = /^\/agents\/([A-Za-z0-9_-]+)\/memories(?:\/semantic\/(status|recall|index))?$/.exec(url)
            if (!match || match[1] !== ENGINE || !memoryRuntime) throw new Error(`Unexpected loopback route ${url}`)
            const method = incoming.method ?? 'GET'
            let result: unknown
            if (!match[2] && method === 'GET') {
                result = { memories: fixture.notes.map(({ id, content, kind, tags, createdAt }) => ({ id, content, kind, tags, createdAt, lastAccessedAt: null, accessCount: 0, strength: 1, status: 'active' })) }
            } else if (match[2] === 'status' && method === 'GET') result = await memoryRuntime.semanticDesktopMemoryStatus(ENGINE)
            else if (match[2] === 'recall' && method === 'POST') {
                const input = desktopSemanticRecallRequestSchema.parse(JSON.parse(body))
                result = await memoryRuntime.recallSemanticDesktopMemory(ENGINE, { ...input, reinforce: 'none' })
            } else if (match[2] === 'index' && method === 'POST') {
                const input = desktopSemanticMaintainSchema.parse(JSON.parse(body))
                result = await memoryRuntime.maintainSemanticDesktopMemory(ENGINE, input.operation)
            } else throw new Error(`Unexpected loopback route ${method} ${url}`)
            outgoing.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify(result))
        } catch (error) {
            const message = error instanceof Error ? error.message.replaceAll(PROVIDER_KEY, '[redacted]') : 'failed'
            if (!outgoing.headersSent) outgoing.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ error: message }))
        }
    })
    function localRequest(path: string, init: RequestInit = {}, authenticated = true) {
        const request = new Request(fixture.origin + path, init)
        const headers = new Headers(init.headers)
        headers.set('host', new URL(fixture.origin).host)
        headers.set('origin', fixture.origin)
        if (authenticated) headers.set('cookie', `rerun-desktop-session=${fixture.sessionToken}`)
        Object.defineProperty(request, 'headers', { value: headers })
        return request
    }
    async function ui(path: string, init: RequestInit, agentId: string) {
        const request = localRequest(path, init)
        const context = { params: Promise.resolve({ agentId }) }
        if (path === '/api/desktop/auxiliary') return init.method === 'PATCH' ? saveAuxiliary(request) : readAuxiliary(request)
        if (path.endsWith('/semantic-memory/index')) return retrySemantic(request, context)
        if (path.includes('/semantic-memory')) return init.method === 'POST' ? recallSemantic(request, context) : readSemantic(request, context)
        return readMemories(request, context)
    }
    await new Promise<void>(resolveListen => server.listen(0, '127.0.0.1', () => resolveListen()))
    fixture.origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`
    vi.stubEnv('RERUN_DESKTOP_SECRET_KEY', 'd'.repeat(64))
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (input, init) => {
        const url = new URL(String(input), fixture.origin)
        if (url.href === 'https://openrouter.ai/api/v1/embeddings') return nativeFetch(fixture.origin + '/fixture/embeddings', init)
        if (url.origin !== fixture.origin) throw new Error(`External traffic forbidden: ${url.origin}`)
        const path = url.pathname
        // The engine callback keeps its bearer header and is not a signed-in UI route.
        if (path === '/api/desktop/internal/semantic-memory') return nativeFetch(input, init)
        const coworker = /^\/api\/desktop\/coworkers\/([^/]+)\/semantic-memory(?:\/index)?$/.exec(path)
        const listed = /^\/api\/desktop\/agents\/([^/]+)\/memories$/.exec(path)
        if (path === '/api/desktop/auxiliary' || coworker || listed) return ui(path, init ?? {}, decodeURIComponent(coworker?.[1] ?? listed?.[1] ?? ''))
        return nativeFetch(input, init)
    }))
    const memoryPath = resolve(import.meta.dirname, '../../../engine/src/desktop/semantic-memory/runtime.ts')
    const brainPath = resolve(import.meta.dirname, '../../../engine/src/desktop/brain-semantic/runtime.ts')
    async function loadRuntimes(initializeBrain: boolean) {
        memoryRuntime = await import(/* @vite-ignore */ memoryPath)
        brainRuntime = await import(/* @vite-ignore */ brainPath)
        if (initializeBrain) await brainRuntime.initializeDesktopBrainSemanticStore()
    }
    function MountedBoard() {
        const searchRef = useRef<HTMLInputElement>(null)
        const [selection, setSelection] = useState<DesktopBrainSelection>({ kind: 'page', slug: 'care' })
        return <>
            <DesktopSettings initialTab="Tool services" providers={providers} workspaceName="Offline fixture" workspaceId={7} onProviders={() => {}} onSave={async () => { throw new Error('This fixture does not change models or defaults') }} />
            <DesktopCoworkerMemories agent={coworker} />
            <div aria-label="Company Brain">
                <DesktopBrainSidebar pages={[summary]} pagesAvailable selection={selection} openProposals={0} searchRef={searchRef} onSelect={setSelection} proposalsAvailable={false} />
                <article aria-label="Canonical Brain page"><h2>{summary.title}</h2><p>{CANON}</p></article>
            </div>
        </>
    }
    async function mount() {
        root = createRoot(document.body.appendChild(document.createElement('div')))
        await act(async () => { root!.render(<MountedBoard />) })
    }
    async function recall(query: string) {
        await typeInto(document.getElementById('desktop-memory-search') as HTMLInputElement, query)
        await click('Search')
        await vi.waitFor(() => expect(dialog()?.textContent ?? '').toContain(`recalled for “${query}”`))
    }
    const noteEmbeds = () => embedded.flatMap(batch => batch.texts).filter(text => text === CANON).length
    try {
        await fixture.db.executeMultiple(`CREATE TABLE desktop_agents(id TEXT PRIMARY KEY, workspace_id INTEGER NOT NULL, engine_agent_id TEXT NOT NULL, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', enabled INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
            CREATE TABLE desktop_space_placements(agent_id TEXT, col INTEGER, row INTEGER, space_id TEXT);
            CREATE TABLE desktop_deletions(agent_id TEXT, engine_agent_id TEXT);
            INSERT INTO desktop_agents VALUES('local-owner',1,'owner','Care coworker','',1,'2026-11-09T00:00:00.000Z','2026-11-09T00:00:00.000Z');
            INSERT INTO desktop_agents VALUES('foreign-owner',2,'foreign','Foreign','',1,'2026-11-09T00:00:00.000Z','2026-11-09T00:00:00.000Z');`)
        const { desktopAuxiliarySchema } = await import('@/lib/desktop/server/auxiliary/store')
        await fixture.db.executeMultiple(desktopAuxiliarySchema)
        await loadRuntimes(true)
        await mount()
        await vi.waitFor(() => expect(serviceText('Memory search')).toContain('Not configured'))
        expect(document.querySelector('[aria-current="page"]')?.textContent).toBe('Tool services')
        expect(serviceText('Memory search')).toContain('OpenRouter')
        expect(serviceText('Memory search')).toContain('text-embedding-3-small')
        expect(serviceText('Memory search')).toContain('Keyword search works without a key.')
        expect(serviceText('Web search')).toContain('Not configured')
        expect(serviceText('Web search')).not.toContain('Remove key')
        expect(serviceText('Voice messages')).toContain('Not configured')
        expect(serviceText('Voice messages')).not.toContain('Remove key')
        expect(document.querySelector('[aria-label="Canonical Brain page"]')?.textContent).toContain(CANON)
        await click('Memories')
        await vi.waitFor(() => expect(dialog()?.textContent).toContain('Keyword search only. An embedding backend is not configured.'))
        expect(dialog()?.textContent).toContain(CANON)
        expect(providerRequests).toBe(0)
        await recall(PARAPHRASE)
        expect(dialog()?.textContent).toContain('0 recalled for')
        expect(dialog()?.textContent).not.toContain(CANON)
        await recall('Canines')
        expect(dialog()?.textContent).toContain(CANON)
        expect(dialog()?.textContent).toContain('Keyword search only. An embedding backend is not configured.')
        expect(providerRequests).toBe(0)
        await click('Done')
        await typeInto(document.getElementById('tool-service-embedding') as HTMLInputElement, PROVIDER_KEY)
        // Web search and Voice messages use the same Save key label. Submit only Memory search.
        const embeddingSave = document.getElementById('tool-service-embedding')!.closest('form')!.querySelector('button[type="submit"]') as HTMLButtonElement
        await act(async () => { embeddingSave.click() })
        await vi.waitFor(() => expect(serviceText('Memory search'), serviceText('Memory search')).toContain('Key saved'))
        expect((document.getElementById('tool-service-embedding') as HTMLInputElement).value).toBe('')
        expect(serviceText('Web search')).toContain('Not configured')
        expect(serviceText('Voice messages')).toContain('Not configured')
        expect(JSON.stringify(await fixture.db.execute('SELECT * FROM desktop_auxiliary_credentials'))).not.toContain(PROVIDER_KEY)
        phase = 'configured'
        await click('Memories')
        await vi.waitFor(() => expect(document.getElementById('desktop-memory-search')).toBeTruthy())
        await recall(PARAPHRASE)
        await vi.waitFor(async () => expect((await (await fetch(`/api/desktop/coworkers/${LOCAL}/semantic-memory`)).json()).indexed).toBe(1), { timeout: 10_000 })
        await recall(PARAPHRASE)
        expect(dialog()?.textContent).toContain('Semantic and keyword matches.')
        expect(dialog()?.textContent).toContain('1 recalled for')
        expect(dialog()?.textContent).toContain(CANON)
        expect(providerRequests).toBeGreaterThan(0)
        await typeInto(brainPane()!.querySelector('input[aria-label="Search pages"]') as HTMLInputElement, 'Dogs')
        expect(brainPane()?.textContent).toContain('No page matches')
        expect(document.querySelector('[aria-label="Canonical Brain page"]')?.textContent).toContain(CANON)
        const brain = await brainRuntime!.desktopBrainSemanticIndex(ENGINE, new AbortController().signal)
        await brain.reconcile(true)
        expect((await brain.search({ query: PARAPHRASE })).hits[0]?.slug).toBe('care')
        phase = 'restart'
        await act(async () => { root!.unmount() }); root = null
        await memoryRuntime!.shutdownDesktopSemanticMemory()
        const savedNoteEmbeds = noteEmbeds()
        const beforeRestart = providerRequests
        vi.resetModules()
        fixture.db.close(); fixture.db = createClient({ url: `file:${join(fixture.root, 'app.db')}` })
        fixture.brain.close(); fixture.brain = createClient({ url: `file:${join(fixture.root, 'brain.db')}` })
        await loadRuntimes(false)
        await mount()
        await vi.waitFor(() => expect(serviceText('Memory search')).toContain('Key saved'))
        expect(serviceText('Web search')).toContain('Not configured')
        expect(serviceText('Voice messages')).toContain('Not configured')
        await click('Memories')
        await vi.waitFor(() => expect(dialog()?.textContent).toMatch(/Semantic and keyword matches|Keyword search only/))
        expect(providerRequests).toBe(beforeRestart)
        phase = 'restart-recall'
        await recall(PARAPHRASE)
        expect(dialog()?.textContent).toContain('Semantic and keyword matches.')
        expect(dialog()?.textContent).toContain(CANON)
        expect(embedded.filter(batch => batch.phase === 'restart-recall').every(batch => batch.texts.every(text => text === PARAPHRASE))).toBe(true)
        expect(noteEmbeds()).toBe(savedNoteEmbeds)
        const reopened = await brainRuntime!.desktopBrainSemanticIndex(ENGINE, new AbortController().signal)
        expect((await reopened.search({ query: PARAPHRASE })).hits[0]?.slug).toBe('care')
        phase = 'offline'
        offline = true
        await recall(PARAPHRASE)
        expect(dialog()?.textContent).toContain('Keyword search only. The embedding backend is unavailable.')
        expect(dialog()?.textContent).not.toContain(CANON)
        await recall('Canines')
        expect(dialog()?.textContent).toContain(CANON)
        expect(dialog()?.textContent).toContain('Keyword search only')
        expect((await reopened.search({ query: PARAPHRASE })).hits).toEqual([])
        expect((await reopened.search({ query: 'Canines' })).hits[0]?.slug).toBe('care')
        offline = false
        phase = 'cleared'
        const beforeClear = providerRequests
        await click('Remove key')
        await vi.waitFor(() => expect(serviceText('Memory search')).toContain('Not configured'))
        expect(serviceText('Memory search')).not.toContain('Remove key')
        await recall(PARAPHRASE)
        expect(dialog()?.textContent).toContain('Keyword search only. An embedding backend is not configured.')
        expect(dialog()?.textContent).toContain('0 recalled for')
        expect(dialog()?.textContent).not.toContain(CANON)
        expect(dialog()?.textContent).not.toContain('Retry indexing')
        const retry = await fetch(`/api/desktop/coworkers/${LOCAL}/semantic-memory/index`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ operation: 'retry' }) })
        expect(retry.status).toBe(200)
        expect(await retry.json()).toMatchObject({ mode: 'keyword-only', backend: null })
        expect(providerRequests).toBe(beforeClear)
        fixture.notes = []
        await fixture.clear!.notesCleared(ENGINE)
        await recall('Canines')
        expect(dialog()?.textContent).toContain('0 recalled for')
        expect(dialog()?.textContent).not.toContain(CANON)
        expect(providerRequests).toBe(beforeClear)
        fixture.grant = false
        await expect(reopened.search({ query: 'Canines' })).rejects.toThrow(/turned off/)
        expect(providerRequests).toBe(beforeClear)
        expect(document.querySelector('[aria-label="Canonical Brain page"]')?.textContent).toContain(CANON)
        expect(JSON.stringify(await fixture.db.execute('SELECT * FROM desktop_auxiliary_credentials'))).not.toContain(PROVIDER_KEY)
        expect((await readAuxiliary(localRequest('/api/desktop/auxiliary', {}, false))).status).toBe(401)
        expect((await fetch(`/api/desktop/coworkers/foreign-owner/semantic-memory`)).status).toBe(404)
        const foreign = await embedCallback(new Request(fixture.origin + '/api/desktop/internal/semantic-memory', { method: 'POST', headers: { host: new URL(fixture.origin).host, authorization: `Bearer ${fixture.engineKey}`, 'content-type': 'application/json' }, body: JSON.stringify({ operation: 'configuration', engineAgentId: 'foreign' }) }))
        expect(foreign.status).toBe(400)
        expect((await fetch(`${fixture.origin}/agents/${ENGINE}/memories/semantic/status`)).status).toBe(401)
        expect(serviceText('Web search')).toContain('Not configured')
        expect(serviceText('Voice messages')).toContain('Not configured')
    } finally {
        await memoryRuntime?.shutdownDesktopSemanticMemory().catch(() => {})
        server.closeAllConnections()
        await new Promise<void>(resolveClose => server.close(() => resolveClose()))
        fixture.db?.close(); fixture.brain?.close()
        if (fixture.root) await rm(fixture.root, { recursive: true, force: true })
        if (root) await act(async () => root!.unmount()); root = null
        vi.unstubAllGlobals(); vi.unstubAllEnvs()
    }
}, 30_000)

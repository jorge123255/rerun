// @vitest-environment happy-dom
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { UIMessage } from 'ai'
import { expect, it, vi } from 'vitest'
import { GET as dataGET } from '@/app/api/desktop/agents/[agentId]/data/[[...path]]/route'
import { GET as preferenceGET, PUT as preferencePUT } from '@/app/api/desktop/agents/[agentId]/data/preferred-view/route'
import { closeDesktopDatabase, openDesktopDatabase } from '@/lib/desktop/server/database'
import { createDesktopAgent } from '@/lib/desktop/server/store'
import { publicDesktopHistory, type HistoryMessage } from '@/lib/chat/engine-history'
import { DesktopAssistantReply } from './DesktopAssistantReply'
import type { DesktopAgentView } from './DesktopApp'

const fixture = vi.hoisted(() => ({ runtime: {} as any }))
vi.mock('server-only', () => ({}))
vi.mock('@/lib/desktop/server/runtime', async original => ({ ...await original<typeof import('@/lib/desktop/server/runtime')>(), readDesktopRuntime: async () => fixture.runtime }))
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

it('reopens one saved card through its authenticated owner/table/view panel, refuses removed/foreign targets and never reruns card_table', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'saved-table-navigation-'))
    const appOrigin = 'http://127.0.0.1:49123', token = 'synthetic-table-session-cookie-for-fixture'
    let mode: 'present' | 'view-removed' | 'table-removed' = 'present'
    const engineCalls: { path: string; method: string }[] = []
    const server = createServer((request, response) => {
        const path = new URL(request.url!, 'http://127.0.0.1').pathname
        engineCalls.push({ path, method: request.method ?? 'GET' })
        response.setHeader('content-type', 'application/json')
        if (request.headers.authorization !== 'Bearer synthetic-engine-key' || !path.startsWith('/agents/engine-original/data/')) { response.writeHead(403).end(JSON.stringify({ error: 'foreign target' })); return }
        if (path.endsWith('/tables')) { response.end(JSON.stringify({ tables: mode === 'table-removed' ? [] : [{ name: 'notes', columns: [{ name: 'body', type: 'TEXT', pk: false, notnull: false }] }] })); return }
        if (mode === 'table-removed') { response.writeHead(404).end(JSON.stringify({ error: 'Table not found.' })); return }
        if (path.endsWith('/views')) { response.end(JSON.stringify({ views: mode === 'view-removed' ? [] : [{ id: 'view-original', table: 'notes', name: 'Saved notes', layout: 'table', columns: ['body'], position: 0 }] })); return }
        if (path.endsWith('/rows')) { response.end(JSON.stringify({ columns: ['body'], rows: [{ body: 'Live owned row' }], total: 1 })); return }
        if (path.endsWith('/export')) { response.setHeader('content-type', 'text/csv'); response.end('body\nLive owned row'); return }
        response.writeHead(404).end(JSON.stringify({ error: 'Unexpected engine route' }))
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const engineOrigin = `http://127.0.0.1:${(server.address() as { port: number }).port}`
    fixture.runtime = { protocolVersion: 1, workspaceId: 1, dataRoot: directory, launchNonce: 'table-fixture', buildId: 'fixture', app: { origin: appOrigin, sessionToken: token }, engine: { origin: engineOrigin, apiKey: 'synthetic-engine-key' } }
    const nativeFetch = globalThis.fetch
    let root: Root | null = null, host: HTMLDivElement | null = null
    const browserCalls: { path: string; method: string }[] = []
    const db = await openDesktopDatabase(directory)
    const original = await createDesktopAgent(db, { engineAgentId: 'engine-original', name: 'Original coworker' })
    const owner = original as unknown as DesktopAgentView
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (input, init = {}) => {
        const url = new URL(String(input), appOrigin)
        if (url.origin === engineOrigin) return nativeFetch(input, init)
        if (url.origin !== appOrigin) throw new Error('External request forbidden')
        browserCalls.push({ path: url.pathname, method: init.method ?? 'GET' })
        const match = /^\/api\/desktop\/agents\/([^/]+)\/data(?:\/(.*))?$/.exec(url.pathname)
        if (!match) throw new Error(`Unexpected browser route ${url.pathname}`)
        const agentId = decodeURIComponent(match[1]!), path = (match[2] ?? '').split('/').filter(Boolean).map(decodeURIComponent)
        const request = new Request(url, { ...init, headers: { ...Object.fromEntries(new Headers(init.headers)), host: new URL(appOrigin).host, origin: appOrigin, cookie: `rerun-desktop-session=${token}` } })
        if (path[0] === 'preferred-view') return (init.method === 'PUT' ? preferencePUT : preferenceGET)(request, { params: Promise.resolve({ agentId }) })
        return dataGET(request, { params: Promise.resolve({ agentId, path }) })
    }))
    const saved: HistoryMessage = { id: 'engine-saved_table_reply', role: 'assistant', parts: [{ type: 'tool-mcp__rerun__card_table', toolName: 'mcp__rerun__card_table', toolCallId: 'saved-table-call', state: 'output-available', input: { table: 'notes', owner: 'forged-owner' }, output: { type: 'text', value: JSON.stringify({ kind: 'table', scope: 'agent', table: 'notes', view: 'Saved notes', columns: ['body'], rows: [{ body: 'Frozen original row' }], total: 1, columnsTruncated: false, agentId: 'forged-owner' }) } }] }
    const history = publicDesktopHistory([saved])
    expect(JSON.stringify(history)).not.toContain('forged-owner')
    async function unmount() { if (root) await act(async () => root!.unmount()); root = null; host?.remove(); host = null }
    async function mount() {
        host = document.body.appendChild(document.createElement('div')); root = createRoot(host)
        await act(async () => root!.render(<><textarea aria-label="Kept chat draft" defaultValue="Keep my draft" /><DesktopAssistantReply message={JSON.parse(JSON.stringify(history[0])) as UIMessage} streaming={false} agentId={owner.id} agent={owner} /></>))
    }
    async function open() {
        const button = [...host!.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.trim() === 'Open database')!
        expect(button).toBeDefined(); await act(async () => button.click())
    }
    async function eventually(check: () => void) { await act(async () => { await vi.waitFor(check) }) }
    try {
        for (let reopen = 0; reopen < 2; reopen++) {
            const before = browserCalls.length
            await mount()
            expect(host!.textContent).toContain('Frozen original row'); expect(browserCalls).toHaveLength(before)
            const draft = host!.querySelector('textarea')!
            await open()
            await eventually(() => expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Live owned row'))
            expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Original coworker')
            expect([...document.querySelectorAll('button[aria-pressed="true"]')].some(button => button.textContent?.includes('Saved notes'))).toBe(true)
            expect(host!.querySelector('textarea')).toBe(draft); expect(draft.value).toBe('Keep my draft')
            await unmount(); await closeDesktopDatabase(directory)
        }
        const exported = await fetch(`/api/desktop/agents/${owner.id}/data/export?table=notes&format=csv`)
        expect(exported.status).toBe(200); expect(await exported.text()).toBe('body\nLive owned row')
        mode = 'view-removed'; await mount(); await open()
        await eventually(() => expect(host!.querySelector('[role="status"]')?.textContent).toContain('no longer available'))
        expect(document.querySelector('[role="dialog"]')).toBeNull(); await unmount()
        mode = 'table-removed'; await mount(); await open()
        await eventually(() => expect(host!.querySelector('[role="status"]')?.textContent).toContain('Table not found'))
        expect(document.querySelector('[role="dialog"]')).toBeNull(); await unmount()
        const beforeForeign = engineCalls.length
        const foreign = await fetch('/api/desktop/agents/raw-engine-foreign/data/export?table=notes&format=csv')
        expect(foreign.status).toBe(404); expect(engineCalls).toHaveLength(beforeForeign)
        expect(engineCalls.every(call => call.method === 'GET' && call.path.startsWith('/agents/engine-original/data/'))).toBe(true)
        expect(browserCalls.every(call => call.path.startsWith(`/api/desktop/agents/${owner.id}/data`) || call.path.startsWith('/api/desktop/agents/raw-engine-foreign/data'))).toBe(true)
        expect(browserCalls.filter(call => call.method !== 'GET').every(call => call.method === 'PUT' && call.path.endsWith('/preferred-view'))).toBe(true)
    } finally {
        await unmount(); vi.unstubAllGlobals(); vi.restoreAllMocks(); await closeDesktopDatabase(directory)
        server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(directory, { recursive: true, force: true })
    }
}, 30_000)

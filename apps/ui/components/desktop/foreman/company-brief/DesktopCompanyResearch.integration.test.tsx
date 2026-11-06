// @vitest-environment happy-dom
import { resolve } from 'node:path'
import { createClient, type Client } from '@libsql/client'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { applyCompanyDiscoveryEvent, emptyCompanyDiscoverySnapshot, type CompanyBriefModelRef, type DesktopCompanyDiscoverySnapshot } from '@rerun/contracts'
import type { DesktopRuntime } from '@/lib/desktop/server/runtime'
import { DESKTOP_FOREMAN_CHAT_SCHEMA } from '@/lib/desktop/server/foreman/chat-store'
import { cancelDraftShutdown } from '@/lib/desktop/draft-writes'

type CompanyBriefCompletion = (input: { selection: CompanyBriefModelRef; prompt: string; signal: AbortSignal }) => Promise<string | null>
type MountedBriefEngine = { fetch(request: Request): Response | Promise<Response>; close(): void }
type EngineFixtureModule = { createMountedCompanyBriefTestEngine(complete: CompanyBriefCompletion): Promise<MountedBriefEngine> }
// Resolve at test runtime: Next's UI compiler must not inherit the Node engine's provider
// implementation graph or require its ES2022 compiler target to type-check these UI assertions.
const engineFixturePath = resolve(import.meta.dirname, '../../../../../engine/src/desktop/company-brief/ui-test-support.ts')

const mounted = vi.hoisted(() => ({
    runtime: null as DesktopRuntime | null,
    db: null as Client | null,
    snapshot: null as DesktopCompanyDiscoverySnapshot | null,
    model: null as CompanyBriefModelRef | null,
}))
vi.mock('@/lib/desktop/server/auth', async original => ({ ...await original<typeof import('@/lib/desktop/server/auth')>(), authenticateDesktopRequest: async () => mounted.runtime }))
vi.mock('@/lib/desktop/server/foreman/binding', () => ({ desktopForeman: async () => ({ db: mounted.db, companyDiscovery: { read: async () => mounted.snapshot ? { state: 'present', owner: 'active', snapshot: mounted.snapshot } : { state: 'absent' } } }) }))
vi.mock('@/lib/desktop/server/company-brief/model', () => ({ resolveForemanCompanyBriefModel: async () => mounted.model }))
vi.mock('@/lib/desktop/server/settings', () => ({ engineOf: () => mounted.runtime!.engine }))
vi.mock('@/lib/engine/client', () => {
    class EngineRequestError extends Error { constructor(readonly status: number) { super('Page unavailable') } }
    return { EngineRequestError, readBrainPage: async () => { throw new EngineRequestError(404) } }
})
vi.mock('@/components/builder/discoveries/DiscoveryCard', () => ({ DiscoveryCard: () => <span>Saved finding</span> }))
import { GET, POST } from '@/app/api/desktop/foreman/company/route'
import { DesktopCompanyResearch } from './DesktopCompanyResearch'

const chat = { workspaceId: '1', chatId: 'fmc_mountedflow0001' }
let root: Root | undefined
let engine: MountedBriefEngine | undefined
let enginePaths: string[], browserActions: Record<string, unknown>[]
const complete = vi.fn(async () => JSON.stringify({ claims: [{ section: 'Overview', text: 'Acme makes public web software.', sources: ['site'] }], unknowns: [] }))

function collectedSite(): DesktopCompanyDiscoverySnapshot {
    const url = 'https://acme.example/', fetchedAt = '2026-11-06T00:00:00.000Z'
    const initial = emptyCompanyDiscoverySnapshot({ ...chat, discoveryId: 'fmx_mountedflow0001', runId: 'run-mountedflow-1', url, domain: 'acme.example', startedAt: fetchedAt })
    const found = applyCompanyDiscoveryEvent(initial, {
        type: 'settled', source: 'site', revision: 1, status: 'found', reason: 'found', fetchedAt,
        provenance: [{ url, fetchedAt, via: 'public-fetch', status: 200 }],
        payload: { kind: 'site', site: { truncated: false, pages: [{ category: 'home', url, title: 'Acme', text: 'Acme makes public web software.' }], productUrls: [], social: [], colors: [], fonts: [], failedPages: [] } },
        findings: [{ kind: 'identity', source: 'site', attribution: { url, fetchedAt, via: 'public-fetch' }, name: 'Acme', oneLiner: 'Public web software', domain: 'acme.example', logoUrl: null }],
    }, fetchedAt)!
    return applyCompanyDiscoveryEvent(found, { type: 'end' }, fetchedAt)!
}

beforeEach(async () => {
    cancelDraftShutdown(); complete.mockClear(); enginePaths = []; browserActions = []
    vi.stubEnv('RERUN_DESKTOP_APP', '1')
    mounted.runtime = { protocolVersion: 1, workspaceId: 1, launchNonce: '00000000-0000-4000-8000-000000000001', buildId: 'mounted-company-flow', dataRoot: '/qa/mounted-company-flow', app: { origin: 'http://127.0.0.1:44000', sessionToken: 'b'.repeat(64) }, engine: { origin: 'http://127.0.0.1:44001', apiKey: 'a'.repeat(64) } }
    mounted.model = { connectionId: 'mac-chatgpt', provider: 'codex', model: 'gpt-6.1-terra', source: 'conversation', agentId: 'foreman', foremanChat: chat }
    mounted.snapshot = null
    mounted.db = createClient({ url: 'file::memory:' })
    await mounted.db.executeMultiple(DESKTOP_FOREMAN_CHAT_SCHEMA)
    await mounted.db.execute({ sql: 'INSERT INTO desktop_foreman_chats(chat_id,workspace_id,engine_session_id) VALUES(?,?,?)', args: [chat.chatId, chat.workspaceId, '00000000-0000-4000-8000-000000000002'] })
    const fixture: unknown = await import(/* @vite-ignore */ engineFixturePath)
    engine = await (fixture as EngineFixtureModule).createMountedCompanyBriefTestEngine(complete)
    const fetcher: typeof fetch = async (input, init) => {
        const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, mounted.runtime!.app.origin)
        const request = new Request(url, init)
        if (url.origin === mounted.runtime!.app.origin && url.pathname === '/api/desktop/foreman/company') {
            if (request.method === 'POST') { browserActions.push(await request.clone().json()); return POST(request) }
            return GET(request)
        }
        if (url.origin === mounted.runtime!.engine.origin) {
            enginePaths.push(url.pathname)
            return engine!.fetch(request)
        }
        throw new Error('Unexpected mounted company request.')
    }
    vi.stubGlobal('fetch', fetcher)
})
afterEach(async () => {
    if (root) await act(async () => root!.unmount())
    root = undefined; document.body.innerHTML = ''
    mounted.db?.close(); engine?.close(); mounted.db = null; engine = undefined
    mounted.snapshot = null; mounted.runtime = null; mounted.model = null
    vi.unstubAllGlobals(); vi.unstubAllEnvs(); cancelDraftShutdown()
})

it('observes completed canonical research through the real browser route and engine policy, then creates a brief only on the mounted button', async () => {
    root = createRoot(document.body.appendChild(document.createElement('div')))
    await act(async () => root!.render(<DesktopCompanyResearch chat={chat} active refreshKey="before-discovery" />))
    expect(document.querySelector('[aria-label="Company research"]')).toBeNull()
    expect(complete).not.toHaveBeenCalled()
    mounted.snapshot = collectedSite()
    await act(async () => root!.render(<DesktopCompanyResearch chat={chat} active refreshKey="discovery-done" />))
    expect(document.querySelector('[aria-label="Company research"]')).not.toBeNull()
    const create = [...document.querySelectorAll('button')].find(button => button.textContent === 'Create company brief')!
    expect(create.disabled).toBe(false)
    expect(complete).not.toHaveBeenCalled()
    await act(async () => create.click())
    expect(browserActions).toHaveLength(1)
    expect(browserActions[0]).toMatchObject({ action: 'synthesize', chat })
    expect(complete).toHaveBeenCalledTimes(1)
    expect(complete).toHaveBeenCalledWith(expect.objectContaining({ selection: mounted.model }))
    expect(enginePaths).toContain('/desktop/company-brief')
    expect(enginePaths).not.toContain('/desktop/company-brief/')
    expect(document.querySelector('[aria-label="Company brief"]')).not.toBeNull()
    expect(document.body.textContent).toContain('Acme makes public web software.')
    expect(document.querySelector('[aria-label="Company research"]')).toBeNull()
    await act(async () => root!.unmount())
    root = createRoot(document.body.appendChild(document.createElement('div')))
    await act(async () => root!.render(<DesktopCompanyResearch chat={chat} active refreshKey="reopened-saved-research" />))
    expect(document.querySelector('[aria-label="Company brief"]')).not.toBeNull()
    expect(document.body.textContent).toContain('Acme makes public web software.')
    expect(browserActions).toHaveLength(1)
    expect(complete).toHaveBeenCalledTimes(1)
})

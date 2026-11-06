// @vitest-environment happy-dom
import { resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createClient, type Client } from '@libsql/client'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { applyCompanyDiscoveryEvent, brainPageResponseSchema, companyBriefAttemptSchema, emptyCompanyDiscoverySnapshot, type CompanyBriefModelRef, type DesktopCompanyDiscoverySnapshot } from '@rerun/contracts'
import type { DesktopRuntime } from '@/lib/desktop/server/runtime'
import { DESKTOP_FOREMAN_CHAT_SCHEMA } from '@/lib/desktop/server/foreman/chat-store'
import { cancelDraftShutdown } from '@/lib/desktop/draft-writes'

type CompanyBriefCompletion = (input: { selection: CompanyBriefModelRef; prompt: string; signal: AbortSignal }) => Promise<string | null>
type MountedBriefEngine = { fetch(request: Request): Response | Promise<Response>; close(): Promise<void> }
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
vi.mock('@/components/builder/discoveries/DiscoveryCard', () => ({ DiscoveryCard: () => <span>Saved finding</span> }))
import { GET, POST } from '@/app/api/desktop/foreman/company/route'
import { DesktopCompanyResearch } from './DesktopCompanyResearch'

const chat = { workspaceId: '1', chatId: 'fmc_mountedflow0001' }
let root: Root | undefined
let engine: MountedBriefEngine | undefined
let enginePaths: string[], browserActions: Record<string, unknown>[]
let requests: Set<Promise<Response>>, browserFailures: { status: number; body: string }[]
const complete = vi.fn(async () => JSON.stringify({ claims: [{ section: 'Overview', text: 'Acme makes public web software.', sources: ['site'] }], unknowns: [] }))
const readStateSchema = z.object({ sourceRevision: z.string().nullable(), attempt: companyBriefAttemptSchema.nullable(), expectedPages: z.array(z.object({ slug: z.string(), expectedPageHash: z.string().regex(/^[a-f0-9]{32}$/).nullable() })) })

async function readCompanyState() {
    const response = await GET(new Request(`${mounted.runtime!.app.origin}/api/desktop/foreman/company?${new URLSearchParams(chat)}`))
    expect(response.status).toBe(200)
    return readStateSchema.parse(await response.json())
}
async function saveCompanyPage(content: string, baseHash: string | null = null) {
    const response = await fetch(`${mounted.runtime!.engine.origin}/desktop/brain/pages/company`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'Company', type: 'company', content, sources: [], baseHash, requestId: randomUUID() }) })
    expect(response.status).toBe(200)
    return brainPageResponseSchema.parse(await response.json())
}
async function waitForUi(assertion: () => void) {
    // File-backed Brain reads outlive act(render). Await the real admitted requests under
    // act, then check the committed DOM; no mocked clock or guessed delay decides success.
    await vi.waitFor(async () => {
        await act(async () => { await Promise.all([...requests]) })
        expect(browserFailures).toEqual([])
        assertion()
    }, { timeout: 3000, interval: 10 })
}

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
    cancelDraftShutdown(); complete.mockClear(); enginePaths = []; browserActions = []; browserFailures = []; requests = new Set()
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    vi.stubEnv('RERUN_DESKTOP_APP', '1')
    mounted.runtime = { protocolVersion: 1, workspaceId: 1, launchNonce: '00000000-0000-4000-8000-000000000001', buildId: 'mounted-company-flow', dataRoot: '/qa/mounted-company-flow', app: { origin: 'http://127.0.0.1:44000', sessionToken: 'b'.repeat(64) }, engine: { origin: 'http://127.0.0.1:44001', apiKey: 'a'.repeat(64) } }
    mounted.model = { connectionId: 'mac-chatgpt', provider: 'codex', model: 'gpt-6.1-terra', source: 'conversation', agentId: 'foreman', foremanChat: chat }
    mounted.snapshot = null
    mounted.db = createClient({ url: 'file::memory:' })
    await mounted.db.executeMultiple(DESKTOP_FOREMAN_CHAT_SCHEMA)
    await mounted.db.execute({ sql: 'INSERT INTO desktop_foreman_chats(chat_id,workspace_id,engine_session_id) VALUES(?,?,?)', args: [chat.chatId, chat.workspaceId, '00000000-0000-4000-8000-000000000002'] })
    const fixture: unknown = await import(/* @vite-ignore */ engineFixturePath)
    engine = await (fixture as EngineFixtureModule).createMountedCompanyBriefTestEngine(complete)
    const routeRequest: typeof fetch = async (input, init) => {
        const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, mounted.runtime!.app.origin)
        const request = new Request(url, init)
        if (url.origin === mounted.runtime!.app.origin && url.pathname === '/api/desktop/foreman/company') {
            if (request.method === 'POST') browserActions.push(await request.clone().json())
            const response = await (request.method === 'POST' ? POST(request) : GET(request))
            if (!response.ok) browserFailures.push({ status: response.status, body: await response.clone().text() })
            return response
        }
        if (url.origin === mounted.runtime!.engine.origin) {
            enginePaths.push(url.pathname)
            return engine!.fetch(request)
        }
        throw new Error('Unexpected mounted company request.')
    }
    const fetcher: typeof fetch = (input, init) => {
        const work = routeRequest(input, init)
        requests.add(work)
        void work.finally(() => requests.delete(work)).catch(() => {})
        return work
    }
    vi.stubGlobal('fetch', fetcher)
})
afterEach(async () => {
    await act(async () => { root?.unmount(); await Promise.allSettled([...requests]) })
    root = undefined; document.body.innerHTML = ''
    mounted.db?.close(); await engine?.close(); mounted.db = null; engine = undefined
    mounted.snapshot = null; mounted.runtime = null; mounted.model = null
    vi.unstubAllGlobals(); vi.unstubAllEnvs(); cancelDraftShutdown()
})

it('observes completed canonical research through the real browser route and engine policy, then creates a brief only on the mounted button', async () => {
    root = createRoot(document.body.appendChild(document.createElement('div')))
    await act(async () => root!.render(<DesktopCompanyResearch chat={chat} active refreshKey="before-discovery" />))
    await waitForUi(() => expect(document.querySelector('[aria-label="Company research"]')).toBeNull())
    expect(complete).not.toHaveBeenCalled()
    const absent = await readCompanyState()
    expect(absent.expectedPages.every(page => page.expectedPageHash === null)).toBe(true)
    const firstPage = await saveCompanyPage('## Overview\nExisting workspace facts.')
    expect((await readCompanyState()).expectedPages.find(page => page.slug === 'company')?.expectedPageHash).toBe(firstPage.page.hash)
    const changedPage = await saveCompanyPage('## Overview\nUpdated workspace facts.', firstPage.page.hash)
    expect(changedPage.page.hash).not.toBe(firstPage.page.hash)
    const changed = await readCompanyState()
    expect(changed.expectedPages.find(page => page.slug === 'company')?.expectedPageHash).toBe(changedPage.page.hash)
    expect(changed.expectedPages.find(page => page.slug === 'offering')?.expectedPageHash).toBeNull()
    mounted.snapshot = collectedSite()
    await act(async () => root!.render(<DesktopCompanyResearch chat={chat} active refreshKey="discovery-done" />))
    await waitForUi(() => expect(document.querySelector('[aria-label="Company research"]')).not.toBeNull())
    const create = [...document.querySelectorAll('button')].find(button => button.textContent === 'Create company brief')!
    expect(create.disabled).toBe(false)
    expect(complete).not.toHaveBeenCalled()
    await act(async () => create.click())
    await waitForUi(() => expect(document.querySelector('[aria-label="Company brief"]')).not.toBeNull())
    expect(browserActions).toHaveLength(1)
    expect(browserActions[0]).toMatchObject({ action: 'synthesize', chat })
    expect(complete).toHaveBeenCalledTimes(1)
    expect(complete).toHaveBeenCalledWith(expect.objectContaining({ selection: mounted.model }))
    expect(enginePaths).toContain('/desktop/company-brief')
    expect(enginePaths).not.toContain('/desktop/company-brief/')
    expect(enginePaths).toContain('/desktop/brain/pages/company')
    expect(enginePaths.some(path => path.startsWith('/brain/'))).toBe(false)
    expect(document.querySelector('[aria-label="Company brief"]')).not.toBeNull()
    expect(document.body.textContent).toContain('Acme makes public web software.')
    expect(document.querySelector('[aria-label="Company research"]')).toBeNull()
    await act(async () => root!.unmount())
    root = createRoot(document.body.appendChild(document.createElement('div')))
    await act(async () => root!.render(<DesktopCompanyResearch chat={chat} active refreshKey="reopened-saved-research" />))
    await waitForUi(() => expect(document.querySelector('[aria-label="Company brief"]')).not.toBeNull())
    expect(document.body.textContent).toContain('Acme makes public web software.')
    expect(browserActions).toHaveLength(1)
    expect(complete).toHaveBeenCalledTimes(1)
})

it('rejects a proposal against the saved absent-page hash after the real desktop Brain page changes', async () => {
    mounted.snapshot = collectedSite()
    const before = await readCompanyState()
    const requestId = randomUUID()
    const makeRequest = (body: unknown) => new Request(`${mounted.runtime!.app.origin}/api/desktop/foreman/company`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    const synthesis = await POST(makeRequest({ action: 'synthesize', chat, requestId, sourceRevision: before.sourceRevision }))
    expect(synthesis.status).toBe(200)
    const attempt = z.object({ attempt: companyBriefAttemptSchema }).parse(await synthesis.json()).attempt
    expect(attempt.status).toBe('accepted')
    const saved = await saveCompanyPage('## Overview\nHuman edits made after research.')
    const response = await POST(makeRequest({ action: 'handoff', chat, requestId, handoffRequestId: randomUUID(), sourceRevision: before.sourceRevision, expectedDraftRevision: attempt.draftRevision, selectedClaimIds: [attempt.result!.claims[0].id], includeDraft: true, expectedPages: before.expectedPages }))
    expect(response.status).toBe(409)
    expect(enginePaths).not.toContain('/desktop/company-brief/handoff')
    const page = await fetch(`${mounted.runtime!.engine.origin}/desktop/brain/pages/company`)
    expect(brainPageResponseSchema.parse(await page.json()).page.hash).toBe(saved.page.hash)
    expect((await readCompanyState()).expectedPages.find(value => value.slug === 'company')?.expectedPageHash).toBe(saved.page.hash)
})

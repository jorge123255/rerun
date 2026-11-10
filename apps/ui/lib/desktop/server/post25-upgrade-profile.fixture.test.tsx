// @vitest-environment happy-dom
// Source-only upgrade of a disposable desktop profile. No Electron, no live service, no real account.

import { mkdtempSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { Client } from '@libsql/client'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, test, vi } from 'vitest'
import { NextRequest, NextResponse } from 'next/server'
import { desktopBackgroundRead } from '@/test/desktop-background-fixture'
import { createDesktopDraftFixture } from '@/test/desktop-draft-fixture'
import { flushTabWrites } from '@/lib/desktop/tab-writes'
import type { DesktopTabLayout, DesktopTabWrite } from '@/lib/desktop/session-tabs'
import { ensureDesktopGeneralTab, generalTabUid } from '@/lib/desktop/general-threads'
import { closeDesktopDatabase, openDesktopDatabase } from './database'
import { readDesktopChats } from './session-tabs'
import { createMcpCredentialGeneration } from './mcp/credential-generation'
import { remoteMcpStore, type OAuthTokenBundle } from './mcp/store'
import { readDesktopUserAttention } from './user-notifications'
import type { DesktopRuntime } from './runtime'
import { createNotificationClickHandoff } from '../../../../desktop/src/main/notification-click-handoff.mjs'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const mocks = vi.hoisted(() => ({ updateSession: vi.fn() }))
vi.mock('@/supabase/middleware', () => ({ updateSession: mocks.updateSession }))
const { proxy } = await import('@/proxy')

const AGENT = 'coworker-a'
const SECRET = 'synthetic-oauth-access-7f3a9c'
const REPLACED = 'synthetic-oauth-access-replaced-7f3a9c'
const KEY = Buffer.alloc(32, 7)
const LAUNCH = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const roots: string[] = []
let rootNode: Root | undefined

afterEach(async () => {
    await act(async () => { rootNode?.unmount() })
    rootNode = undefined
    document.body.innerHTML = ''
    for (const root of roots.splice(0)) {
        await closeDesktopDatabase(root).catch(() => undefined)
    }
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
})

test('a shipped desktop profile keeps chats, tabs, drafts, a pending notification and one canonical MCP credential', async () => {
    const root = mkdtempSync(resolve(tmpdir(), 'rerun-post25-upgrade-'))
    roots.push(root)
    process.env.RERUN_DESKTOP_APP = '1'
    process.env.RERUN_DESKTOP_DATA_DIR = root
    process.env.RERUN_DESKTOP_WORKSPACE_NAME = 'Synthetic workspace'
    process.env.RERUN_DESKTOP_WORKSPACE_ID = '1'
    const db = await openDesktopDatabase(root)
    const schemaBefore = await schemaRows(db)
    await db.execute({ sql: 'INSERT INTO desktop_agents (id, workspace_id, engine_agent_id, name, description, enabled, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)', args: [AGENT, 1, 'engine-coworker-a', 'Ada', '', 1, '2026-11-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z'] })
    await db.execute({ sql: "INSERT INTO desktop_sessions (id, agent_id, engine_session_id, title, created_at, updated_at, kind) VALUES (?,?,?,?,?,?, 'general'), (?,?,?,?,?,?, 'thread')", args: ['general-session', AGENT, 'engine-general', 'General', '2026-11-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z', 'thread-session', AGENT, 'engine-thread', 'Launch thread', '2026-11-01T00:00:01.000Z', '2026-11-01T00:00:01.000Z'] })
    const layout = { activeIndex: 1, tabs: [{ uid: generalTabUid(AGENT), id: 'general-session' }, { uid: 'thread-tab', id: 'thread-session' }] }
    await db.execute({ sql: 'INSERT INTO desktop_agent_tabs (agent_id, revision, layout) VALUES (?,?,?)', args: [AGENT, 4, JSON.stringify(layout)] })
    await db.execute({ sql: 'INSERT INTO desktop_composer_drafts (agent_id, tab_uid, revision, text, updated_at) VALUES (?,?,?,?,?), (?,?,?,?,?)', args: [AGENT, generalTabUid(AGENT), 1, 'Unsent general note', '2026-11-01T00:00:04.000Z', AGENT, 'thread-tab', 1, 'Unsent thread note', '2026-11-01T00:00:05.000Z'] })
    await db.execute({
        sql: `INSERT INTO desktop_user_notifications (id, event_key, attempt_id, workspace_id, agent_engine_id, agent_local_id, session_engine_id, session_local_id, run_id, tool_call_id, message, created_at)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        args: ['notify-1', 'notify-user:engine-coworker-a:engine-thread:run-1:call-1', 'attempt-1', 1, 'engine-coworker-a', AGENT, 'engine-thread', 'thread-session', 'run-1', 'call-1', 'Review the synthetic launch note', '2026-11-01T00:00:06.000Z'],
    })
    await db.execute({ sql: 'INSERT INTO desktop_remote_mcp (id, transport, agent_id, name, url, revision, bearer) VALUES (?,?,?,?,?,?,NULL)', args: ['reg-synthetic', 'http', AGENT, 'linear', 'https://mcp.example/mcp', 'rev-shipped'] })
    const store = remoteMcpStore(db, () => KEY)
    const bundle = (accessToken: string): OAuthTokenBundle => ({
        accessToken, expiresAt: 1_800_000_000_000, resource: 'https://mcp.example/mcp', issuer: 'https://issuer.example',
        tokenEndpoint: 'https://issuer.example/token', clientId: 'synthetic-client',
    })
    await store.writeOAuth(AGENT, 'linear', 'rev-shipped', bundle(SECRET), new AbortController().signal)
    const sealedBefore = String((await db.execute({ sql: 'SELECT bundle FROM desktop_remote_mcp_oauth WHERE agent_id = ? AND name = ?', args: [AGENT, 'linear'] })).rows[0]?.bundle)
    expect(sealedBefore).not.toContain(SECRET)
    expect(Buffer.from(sealedBefore, 'base64').includes(Buffer.from(SECRET))).toBe(false)

    const runtime: DesktopRuntime = {
        protocolVersion: 1, workspaceId: 1, launchNonce: LAUNCH, buildId: 'post25-fixture', dataRoot: root,
        app: { origin: 'http://127.0.0.1:43110', sessionToken: 's'.repeat(32) },
        engine: { origin: 'http://127.0.0.1:43111', apiKey: 'fixture-only' },
    }
    const chats = await readDesktopChats(db, AGENT)
    const pinned = ensureDesktopGeneralTab(AGENT, chats.tabs!, 'general-session')
    expect(pinned.activeIndex).toBe(1)
    expect(pinned.tabs.map(tab => ({ uid: tab.uid, id: tab.id }))).toEqual(layout.tabs)
    expect(chats.tabs?.revision).toBe(4)
    const attention = await readDesktopUserAttention(db, runtime)
    expect(attention.map(item => item.summary)).toEqual(['Review the synthetic launch note'])
    const generation = createMcpCredentialGeneration({ store, key: () => KEY, ttlMs: 60_000, now: () => 0 })
    const lease = await generation.read(AGENT, 'linear')
    expect(lease?.generation).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(JSON.stringify(lease)).not.toContain(SECRET)
    const advanced = await generation.advance(AGENT, 'linear', lease!.generation, bundle(REPLACED), new AbortController().signal)
    expect(advanced.generation).not.toBe(lease?.generation)
    await expect(generation.advance(AGENT, 'linear', lease!.generation, bundle('synthetic-oauth-access-late'), new AbortController().signal)).rejects.toThrow('MCP credential generation changed')
    const sealedAfter = String((await db.execute({ sql: 'SELECT bundle FROM desktop_remote_mcp_oauth WHERE agent_id = ? AND name = ?', args: [AGENT, 'linear'] })).rows[0]?.bundle)
    expect(sealedAfter).not.toBe(sealedBefore)
    expect(sealedAfter).not.toContain(REPLACED)
    expect((await store.readOAuth(AGENT, 'linear'))?.accessToken).toBe(REPLACED)
    const handoff = createNotificationClickHandoff()
    const click = { key: 'notify-user:engine-coworker-a:engine-thread:run-1:call-1', kind: 'info', agentId: AGENT, sessionId: 'thread-session', title: 'Ada', body: SECRET }
    expect(handoff.accept(click, { workspaceId: 1, launchNonce: LAUNCH })).toBe('held')
    expect(handoff.flush({ workspaceId: 1, launchNonce: LAUNCH }, () => false)).toEqual([])
    const delivered: unknown[] = []
    expect(handoff.flush({ workspaceId: 1, launchNonce: LAUNCH }, (value: { key: string; kind: string; agentId: string; sessionId: string }) => { delivered.push(value); return true })).toHaveLength(1)
    expect(JSON.stringify(delivered)).not.toContain(SECRET)
    // FIXTURE-EXPECTATION: index.mjs holds this same target until the current BrowserWindow frame is ready. Electron is not launched here.

    await closeDesktopDatabase(root)
    const again = await openDesktopDatabase(root)
    expect(await schemaRows(again)).toEqual(schemaBefore)
    const restored = await readDesktopChats(again, AGENT)
    expect(restored.tabs?.revision).toBe(4)
    expect(restored.tabs?.activeIndex).toBe(1)
    expect(restored.tabs?.tabs.map(tab => ({ uid: tab.uid, id: tab.id }))).toEqual(layout.tabs)
    expect((await again.execute('SELECT tab_uid, text FROM desktop_composer_drafts ORDER BY tab_uid')).rows).toEqual([
        { tab_uid: generalTabUid(AGENT), text: 'Unsent general note' },
        { tab_uid: 'thread-tab', text: 'Unsent thread note' },
    ])
    expect((await readDesktopUserAttention(again, runtime)).map(item => item.id)).toEqual(['attempt-1'])
    const storeAgain = remoteMcpStore(again, () => KEY)
    const generationAgain = createMcpCredentialGeneration({ store: storeAgain, key: () => KEY, ttlMs: 60_000, now: () => 0 })
    const reread = await generationAgain.read(AGENT, 'linear')
    expect(reread?.generation).toBe(advanced.generation)
    expect(String((await again.execute({ sql: 'SELECT bundle FROM desktop_remote_mcp_oauth WHERE agent_id = ?', args: [AGENT] })).rows[0]?.bundle)).toBe(sealedAfter)
    const appDb = await readFile(join(root, 'app.db'))
    expect(appDb.includes(Buffer.from(SECRET))).toBe(false)
    expect(appDb.includes(Buffer.from(REPLACED))).toBe(false)
    expect((await again.execute('SELECT name FROM desktop_workspace WHERE id = 1')).rows[0]?.name).toBe('Synthetic workspace')

    mocks.updateSession.mockResolvedValue(NextResponse.next())
    delete process.env.RERUN_DESKTOP_APP
    await proxy(new NextRequest('http://127.0.0.1:3100/board'))
    expect(mocks.updateSession).toHaveBeenCalledTimes(1)
    mocks.updateSession.mockClear()
    process.env.RERUN_DESKTOP_APP = '1'
    await proxy(new NextRequest('http://127.0.0.1:3100/api/desktop/health'))
    expect(mocks.updateSession).not.toHaveBeenCalled()
}, 60000)

async function schemaRows(db: Client) {
    return (await db.execute('SELECT version, id FROM desktop_schema_migrations ORDER BY version')).rows.map(row => ({ version: Number(row.version), id: String(row.id) }))
}

test('reopening a saved General and thread layout does not write it back', async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL ??= 'http://127.0.0.1:54321'
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ??= 'sb_publishable_disposable_offline_fixture'
    const { DesktopChatTabs } = await import('@/components/desktop/DesktopChatTabs')
    const agent = { id: AGENT, name: 'Ada', description: '', createdAt: '', updatedAt: '' }
    const sessions = [
        { id: 'general-session', agentId: agent.id, title: 'General', kind: 'general' as const, createdAt: '', updatedAt: '' },
        { id: 'thread-session', agentId: agent.id, title: 'Launch thread', createdAt: '', updatedAt: '' },
    ]
    const initialLayout: DesktopTabLayout = {
        revision: 4,
        activeIndex: 1,
        tabs: [
            { uid: generalTabUid(agent.id), id: 'general-session', title: 'General' },
            { uid: 'thread-tab', id: 'thread-session', title: 'Launch thread' },
        ],
    }
    const drafts = createDesktopDraftFixture()
    drafts.seedTabs(agent.id, initialLayout.tabs)
    drafts.handle(`/api/desktop/agents/${agent.id}/draft`, { method: 'PUT', body: JSON.stringify({ tabUid: generalTabUid(agent.id), requestId: crypto.randomUUID(), baseRevision: 0, text: 'Unsent general note' }) })
    drafts.handle(`/api/desktop/agents/${agent.id}/draft`, { method: 'PUT', body: JSON.stringify({ tabUid: 'thread-tab', requestId: crypto.randomUUID(), baseRevision: 0, text: 'Unsent thread note' }) })
    const writes: DesktopTabWrite[] = []
    const unexpected: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input), 'http://127.0.0.1')
        const method = init?.method ?? 'GET'
        if (url.pathname === `/api/desktop/agents/${agent.id}/tabs` && method === 'PUT') {
            writes.push(JSON.parse(String(init?.body)) as DesktopTabWrite)
            return Response.json({ tabs: initialLayout })
        }
        const draftResponse = drafts.handle(input, init)
        if (draftResponse) return draftResponse
        if (url.pathname.endsWith('/messages') && method === 'GET') return Response.json({ messages: [] })
        if (url.pathname.endsWith('/questions') && method === 'GET') return Response.json({ question: null })
        if (url.pathname.endsWith('/approvals') && method === 'GET') return Response.json({ approval: null })
        if (url.pathname.endsWith('/feedback') && method === 'GET') return Response.json({ votes: [] })
        if (url.pathname.endsWith('/queue') && method === 'GET') return Response.json({ queued: null })
        if (url.pathname.endsWith('/stop')) return Response.json({ running: false })
        if (url.pathname.endsWith('/model') && method === 'GET') return Response.json({ catalog: [], workspace: null, coworker: null, conversation: null, effective: { source: 'workspace', connectionId: null, provider: null, name: null, model: null, label: 'Select model', available: false } })
        const background = desktopBackgroundRead(input, init)
        if (background) return background
        unexpected.push(`${method} ${url.pathname}`)
        throw new Error(`Unexpected request: ${method} ${url.pathname}`)
    }))
    const container = document.body.appendChild(document.createElement('div'))
    rootNode = createRoot(container)
    await act(async () => {
        rootNode!.render(<DesktopChatTabs agent={agent} sessions={sessions} initialLayout={initialLayout} requested={null} selected refreshSessions={async () => {}} reload={() => {}} onClosePanel={() => {}} onOpenModelSettings={() => {}} />)
    })
    await act(async () => { await flushTabWrites() })
    expect(writes).toEqual([])
    expect(unexpected).toEqual([])
    expect((await drafts.handle(`/api/desktop/agents/${agent.id}/draft?tabUid=${generalTabUid(agent.id)}`)!.json()).draft.text).toBe('Unsent general note')
    expect((await drafts.handle(`/api/desktop/agents/${agent.id}/draft?tabUid=thread-tab`)!.json()).draft.text).toBe('Unsent thread note')
}, 20000)

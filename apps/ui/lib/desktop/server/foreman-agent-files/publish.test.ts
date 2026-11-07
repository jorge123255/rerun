import { createClient } from '@libsql/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { DesktopRuntime } from '../runtime'
import { DesktopHttpError } from '../auth'
import { privateFileReceiptSchema } from '../private-file-tools/schema'
import { FOREMAN_AGENT_FILE_COPY } from './contract'
import { desktopRouteAllowed } from '../../../../../engine/src/desktop/policy'

const mocks = vi.hoisted(() => ({ runtime: vi.fn(), open: vi.fn(), read: vi.fn(), save: vi.fn(), create: vi.fn() }))
vi.mock('server-only', () => ({}))
vi.mock('../runtime', () => ({ readDesktopRuntime: mocks.runtime }))
vi.mock('../database', () => ({ openDesktopDatabase: mocks.open }))
vi.mock('../coworker-files', () => ({ readPrivateCoworkerFile: mocks.read, saveCoworkerFile: mocks.save, importCoworkerFile: mocks.create }))

import { handleDesktopForemanAgentFilePublication } from './publish'

const runtime = {
    protocolVersion: 1, workspaceId: 1, dataRoot: '/foreman-agent-files-test', launchNonce: '11111111-1111-4111-8111-111111111111', buildId: 'test',
    app: { origin: 'http://127.0.0.1:3001', sessionToken: 'browser-session-token-is-not-the-engine-key' },
    engine: { origin: 'http://127.0.0.1:3002', apiKey: 'engine-only' },
} as DesktopRuntime

const writeBody = { engineAgentId: 'notes', sessionId: 'session', runId: 'run', toolCallId: 'call', tool: 'fs_write', arguments: { path: 'note.md', content: 'hello' } }
let db: ReturnType<typeof createClient>
let fetches: string[]

function request(body: unknown = writeBody, headers: Record<string, string> = { authorization: 'Bearer engine-only' }, signal?: AbortSignal) {
    return new Request(`${runtime.app.origin}/api/desktop/internal/foreman-agent-files`, {
        method: 'POST', headers: { host: '127.0.0.1:3001', 'content-type': 'application/json', ...headers }, body: JSON.stringify(body), signal,
    })
}

function engine(granted = true, status = 'running', identity = { workspaceId: String(runtime.workspaceId), launchNonce: runtime.launchNonce }) {
    fetches = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
        fetches.push(String(url))
        // Use the actual native allowlist rather than a permissive getAgent stub.
        if (!desktopRouteAllowed(init?.method ?? 'GET', new URL(String(url)).pathname)) return Response.json({ error: 'Native route refused' }, { status: 403 })
        if (String(url).endsWith('/desktop/foreman/file-permissions')) return Response.json({ ...identity, grants: { foremanAgentFilesRead: false, foremanAgentFilesWrite: granted } })
        if (String(url).endsWith('/runs/run')) return Response.json({ id: 'run', agentId: 'foreman', sessionId: 'session', status })
        if (String(url).endsWith('/agents/notes')) return Response.json({ id: 'notes' })
        return new Response('missing', { status: 404 })
    }))
}

beforeEach(async () => {
    Reflect.deleteProperty(globalThis, Symbol.for('rerun.desktop.foreman-agent-file.publishers.v1'))
    vi.resetAllMocks()
    db = createClient({ url: 'file::memory:' })
    await db.executeMultiple(`CREATE TABLE desktop_agents(id TEXT PRIMARY KEY, engine_agent_id TEXT, workspace_id INTEGER);
        CREATE TABLE desktop_deletions(agent_id TEXT, engine_agent_id TEXT);
        INSERT INTO desktop_agents VALUES('local-notes','notes',1);
        ${privateFileReceiptSchema}`)
    mocks.runtime.mockResolvedValue(runtime)
    mocks.open.mockResolvedValue(db)
    mocks.read.mockRejectedValue(Object.assign(new Error('missing'), { code: 'ENOENT' }))
    mocks.create.mockImplementation(async () => {
        mocks.read.mockResolvedValue({ content: 'hello', hash: 'hash', identity: '1:2', truncated: false })
        return { path: 'note.md', name: 'note.md' }
    })
    engine()
})

afterEach(() => { db.close(); vi.unstubAllGlobals(); Reflect.deleteProperty(globalThis, Symbol.for('rerun.desktop.foreman-agent-file.publishers.v1')) })

test('a browser session cannot publish a coworker file', async () => {
    const response = await handleDesktopForemanAgentFilePublication(request(writeBody, { cookie: 'rerun-desktop-session=browser-session-token-is-not-the-engine-key' }))
    expect(response.status).toBe(401)
    expect(mocks.create).not.toHaveBeenCalled()
    expect(fetches).toEqual([])
})

test('publication composes with native route policy while generic managed-Foreman reads remain closed', async () => {
    expect(desktopRouteAllowed('GET', '/agents/foreman')).toBe(false)
    expect(desktopRouteAllowed('GET', '/desktop/foreman/file-permissions')).toBe(true)
    const response = await handleDesktopForemanAgentFilePublication(request())
    expect(await response.json()).toMatchObject({ status: 'saved', path: 'note.md' })
    expect(fetches.some(url => new URL(url).pathname === '/agents/foreman')).toBe(false)
    expect(fetches.some(url => new URL(url).pathname === '/desktop/foreman/file-permissions')).toBe(true)
})

test('a permission snapshot from another workspace or launch cannot authorize publication', async () => {
    engine(true, 'running', { workspaceId: '2', launchNonce: runtime.launchNonce })
    expect((await (await handleDesktopForemanAgentFilePublication(request())).json()).status).toBe('refused')
    engine(true, 'running', { workspaceId: '1', launchNonce: '22222222-2222-4222-8222-222222222222' })
    expect((await (await handleDesktopForemanAgentFilePublication(request())).json()).status).toBe('refused')
    expect(mocks.create).not.toHaveBeenCalled()
})

test('an aliased or multiply linked existing text path is refused before publication', async () => {
    mocks.read.mockRejectedValue(new Error('Not a singly linked owned document.'))
    const create = await handleDesktopForemanAgentFilePublication(request())
    expect((await create.json()).status).toBe('refused')
    const edit = await handleDesktopForemanAgentFilePublication(request({ ...writeBody, tool: 'fs_edit', arguments: { path: 'note.md', oldString: 'a', newString: 'b' } }))
    expect((await edit.json()).status).toBe('refused')
    expect(mocks.create).not.toHaveBeenCalled()
    expect(mocks.save).not.toHaveBeenCalled()
})

test('non-text and hidden paths are refused before any publication', async () => {
    const response = await handleDesktopForemanAgentFilePublication(request({ ...writeBody, arguments: { path: 'picture.png', content: 'hello' } }))
    expect(await response.json()).toMatchObject({ status: 'refused', message: FOREMAN_AGENT_FILE_COPY.nonTextWrite })
    expect(mocks.read).not.toHaveBeenCalled()
    expect(mocks.create).not.toHaveBeenCalled()
    expect(fetches).toEqual([])
    const hidden = await handleDesktopForemanAgentFilePublication(request({ ...writeBody, arguments: { path: '.rerun/note.md', content: 'hello' } }))
    expect(await hidden.json()).toMatchObject({ status: 'refused' })
    expect(mocks.create).not.toHaveBeenCalled()
})

test('another workspace, a missing grant, and an existing file do not publish', async () => {
    const other = await handleDesktopForemanAgentFilePublication(request({ ...writeBody, engineAgentId: 'elsewhere' }))
    expect(await other.json()).toMatchObject({ status: 'refused', message: FOREMAN_AGENT_FILE_COPY.workspace })
    expect(mocks.create).not.toHaveBeenCalled()
    engine(false)
    const off = await handleDesktopForemanAgentFilePublication(request())
    expect(await off.json()).toMatchObject({ status: 'refused', message: FOREMAN_AGENT_FILE_COPY.off })
    expect(mocks.create).not.toHaveBeenCalled()
    engine(true)
    mocks.read.mockResolvedValueOnce({ content: 'already', hash: 'hash', identity: '1:2', truncated: false })
    const exists = await handleDesktopForemanAgentFilePublication(request())
    expect((await exists.json()).message).toContain('already exists')
    expect(mocks.create).not.toHaveBeenCalled()
})

test('a missing edit is a refusal and a create publishes once', async () => {
    const edit = { ...writeBody, tool: 'fs_edit', arguments: { path: 'note.md', oldString: 'old', newString: 'new' } }
    mocks.read.mockRejectedValueOnce(new DesktopHttpError(404, 'File not found'))
    const missing = await handleDesktopForemanAgentFilePublication(request(edit))
    expect(await missing.json()).toMatchObject({ status: 'refused' })
    expect(mocks.save).not.toHaveBeenCalled()
    expect(mocks.create).not.toHaveBeenCalled()
    mocks.read.mockRejectedValue(Object.assign(new Error('missing'), { code: 'ENOENT' }))
    const created = await handleDesktopForemanAgentFilePublication(request())
    expect(await created.json()).toMatchObject({ status: 'saved', path: 'note.md' })
    expect(mocks.create).toHaveBeenCalledTimes(1)
    const replay = await handleDesktopForemanAgentFilePublication(request())
    expect(await replay.json()).toMatchObject({ status: 'saved', path: 'note.md' })
    expect(mocks.create).toHaveBeenCalledTimes(1)
    // A completed receipt survives a later move; reconciliation must not inspect or recreate it.
    mocks.read.mockRejectedValue(new DesktopHttpError(404, 'File not found'))
    const movedReplay = await handleDesktopForemanAgentFilePublication(request())
    expect(await movedReplay.json()).toMatchObject({ status: 'saved', path: 'note.md' })
    expect(mocks.create).toHaveBeenCalledTimes(1)
})

test('the same call with different text conflicts and an aborted engine read is not retried', async () => {
    expect((await (await handleDesktopForemanAgentFilePublication(request())).json()).status).toBe('saved')
    const changed = await handleDesktopForemanAgentFilePublication(request({ ...writeBody, arguments: { path: 'note.md', content: 'different' } }))
    expect((await changed.json()).status).toBe('refused')
    expect(mocks.create).toHaveBeenCalledTimes(1)
    engine()
    vi.stubGlobal('fetch', vi.fn(async () => { fetches.push('once'); throw new Error('unavailable') }))
    const failed = await handleDesktopForemanAgentFilePublication(request({ ...writeBody, toolCallId: 'other-call' }))
    expect((await failed.json()).status).toBe('refused')
    expect(fetches).toEqual(['once', 'once', 'once'])
    expect(mocks.create).toHaveBeenCalledTimes(1)
})

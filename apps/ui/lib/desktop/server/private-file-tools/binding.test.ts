import { createClient } from '@libsql/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { DesktopRuntime } from '../runtime'
const mocks = vi.hoisted(() => ({runtime: vi.fn(), open: vi.fn(), service: vi.fn(), read: vi.fn(), save: vi.fn(), create: vi.fn()}))
vi.mock('server-only', () => ({}))
vi.mock('../runtime', () => ({readDesktopRuntime: mocks.runtime}))
vi.mock('../database', () => ({openDesktopDatabase: mocks.open}))
vi.mock('../mcp-binding', () => ({getDesktopRemoteMcpService: mocks.service}))
vi.mock('../coworker-files', () => ({readPrivateCoworkerFile: mocks.read, saveCoworkerFile: mocks.save, importCoworkerFile: mocks.create}))
import { handleDesktopPrivateFileTool } from './binding'
import { privateFileReceiptSchema } from './schema'

const runtime: DesktopRuntime = {protocolVersion: 1, workspaceId: 1, dataRoot: '/private-test', launchNonce: 'launch', buildId: 'test',
    app: {origin: 'http://127.0.0.1:3001', sessionToken: 'browser-only'}, engine: {origin: 'http://127.0.0.1:3002', apiKey: 'engine-only'}}
const body = {engineAgentId: 'engine-owner', sessionId: 'session', runId: 'run', toolCallId: 'call', tool: 'fs_edit', arguments: {path: 'note.md', oldString: 'old', newString: 'new'}}
const request = (signal?: AbortSignal, headers: Record<string, string> = {authorization: 'Bearer engine-only'}) => new Request(`${runtime.app.origin}/api/desktop/engine/private-file-tools`, {
    method: 'POST', headers: {host: '127.0.0.1:3001', ...headers}, body: JSON.stringify(body), signal,
})
let db: ReturnType<typeof createClient>, shutdown: AbortController
let service: {shutdownSignal: AbortSignal; authorizeRun: ReturnType<typeof vi.fn>}
beforeEach(async () => {
    Reflect.deleteProperty(globalThis, Symbol.for('rerun.desktop.private-file.publishers.v1'))
    vi.resetAllMocks()
    db = createClient({url: 'file::memory:'})
    await db.executeMultiple("CREATE TABLE desktop_agents(id TEXT PRIMARY KEY); INSERT INTO desktop_agents VALUES('local-owner');" + privateFileReceiptSchema)
    shutdown = new AbortController()
    service = {shutdownSignal: shutdown.signal, authorizeRun: vi.fn(async (call: typeof body, signal: AbortSignal, grant: string) => {
        signal.throwIfAborted()
        expect(call).toEqual(body); expect(grant).toBe('privateFileWrite')
        return 'local-owner'
    })}
    mocks.runtime.mockResolvedValue(runtime); mocks.open.mockResolvedValue(db); mocks.service.mockResolvedValue(service)
    mocks.read.mockResolvedValue({content: 'old', hash: 'hash', identity: '1:2', truncated: false})
    mocks.save.mockResolvedValue({path: 'note.md'})
})
afterEach(() => {db.close(); Reflect.deleteProperty(globalThis, Symbol.for('rerun.desktop.private-file.publishers.v1'))})

test('the human session cookie cannot authorize a model write', async () => {
    const response = await handleDesktopPrivateFileTool(request(undefined, {cookie: 'rerun-desktop-session=browser-only', origin: runtime.app.origin}))
    expect(response.status).toBe(401)
    expect(mocks.service).not.toHaveBeenCalled(); expect(mocks.save).not.toHaveBeenCalled()
})

test('independently bundled routes share the pending publisher and durable exact-call receipt', async () => {
    let release!: () => void, entered!: () => void
    const started = new Promise<void>(resolve => {entered = resolve})
    mocks.save.mockImplementation(async () => {entered(); await new Promise<void>(resolve => {release = resolve})})
    const first = handleDesktopPrivateFileTool(request())
    await started
    vi.resetModules()
    const separate = await import('./binding')
    const second = separate.handleDesktopPrivateFileTool(request())
    await vi.waitFor(() => expect(mocks.service).toHaveBeenCalledTimes(2))
    release()
    expect(await (await first).json()).toMatchObject({status: 'saved'})
    expect(await (await second).json()).toMatchObject({status: 'saved'})
    expect(mocks.save).toHaveBeenCalledTimes(1)
    expect(mocks.read.mock.calls[0]?.slice(0, 3)).toEqual([runtime, 'local-owner', 'note.md'])
    expect(await (await separate.handleDesktopPrivateFileTool(request())).json()).toMatchObject({status: 'saved'})
    expect(mocks.save).toHaveBeenCalledTimes(1)
})

test('Stop covers the trusted runtime read before service or database initialization', async () => {
    let entered!: () => void
    const started = new Promise<void>(resolve => {entered = resolve})
    mocks.runtime.mockImplementation(() => {entered(); return new Promise(() => {})})
    const stop = new AbortController(), pending = handleDesktopPrivateFileTool(request(stop.signal))
    await started; stop.abort()
    expect((await pending).status).toBe(400)
    expect(mocks.service).not.toHaveBeenCalled(); expect(mocks.open).not.toHaveBeenCalled()
})

test('terminal UI shutdown releases the observer and prevents a queued file publication', async () => {
    let release!: () => void, entered!: () => void, published = false
    const started = new Promise<void>(resolve => {entered = resolve})
    mocks.save.mockImplementation(async (...args: unknown[]) => {
        entered(); await new Promise<void>(resolve => {release = resolve})
        await (args[6] as {beforePublish: () => Promise<void>}).beforePublish()
        published = true
    })
    const pending = handleDesktopPrivateFileTool(request())
    await started
    shutdown.abort()
    expect(await (await pending).json()).toMatchObject({status: 'unknown'})
    release()
    const refused = await handleDesktopPrivateFileTool(request())
    expect(refused.status).toBe(400)
    expect(published).toBe(false)
})

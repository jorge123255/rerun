import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { closeDesktopDatabase, openDesktopDatabase } from '@/lib/desktop/server/database'
import { createDesktopAgent } from '@/lib/desktop/server/store'
import { POST } from './route'

vi.mock('@rerun/contracts', async importOriginal => ({
    ...await importOriginal<typeof import('@rerun/contracts')>(),
    MAX_UPLOAD_FILE_BYTES: 4,
}))

let root: string, agentId: string, workspace: string
const token = 'a'.repeat(48)
const origin = 'http://127.0.0.1:3190'

beforeEach(async () => {
    root = await mkdtemp(join(await realpath(tmpdir()), 'rerun-import-route-'))
    vi.stubEnv('RERUN_DESKTOP_APP', '1')
    vi.stubEnv('RERUN_DESKTOP_DATA_DIR', root)
    vi.stubEnv('RERUN_DESKTOP_RUNTIME_FILE', join(root, 'runtime.json'))
    await writeFile(join(root, 'runtime.json'), JSON.stringify({ protocolVersion: 1, launchNonce: 'import', buildId: 'import-test', workspaceId: 1, dataRoot: root,
        app: { origin, sessionToken: token }, engine: { origin: 'http://127.0.0.1:9', apiKey: 'unused' } }), { mode: 0o600 })
    const db = await openDesktopDatabase(root)
    agentId = (await createDesktopAgent(db, { engineAgentId: 'engine-alice', name: 'Alice' })).id
    workspace = join(root, 'workspaces', '1', 'engine', 'agents', 'engine-alice', 'workspace')
    await mkdir(workspace, { recursive: true })
})

afterEach(async () => {
    await closeDesktopDatabase(root)
    vi.unstubAllEnvs()
    await rm(root, { recursive: true, force: true })
})

function send(body?: BodyInit, declared?: string, signal?: AbortSignal) {
    const headers = new Headers({ host: '127.0.0.1:3190', origin, cookie: `rerun-desktop-session=${token}` })
    if (declared) headers.set('content-length', declared)
    const init = { method: 'POST', headers, body, duplex: 'half', signal } as RequestInit
    return POST(new Request(`${origin}/api/desktop/agents/${agentId}/files/import?path=note.txt`, init), { params: Promise.resolve({ agentId }) })
}

test('rejects an oversized Content-Length before reading or publishing', async () => {
    const response = await send('ok', '5')
    expect(response.status).toBe(413)
    expect(await response.json()).toMatchObject({ code: 'too_large' })
    await expect(readFile(join(workspace, 'note.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
})

test('refuses a body shorter than its declared size before publishing', async () => {
    const response = await send('ok', '4')
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ error: 'The upload size did not match the file size.' })
    await expect(readFile(join(workspace, 'note.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
})

test('cancels a chunked body at the limit without reading its tail', async () => {
    const cancel = vi.fn()
    let reads = 0
    const response = await send(new ReadableStream<Uint8Array>({
        pull(controller) {
            reads += 1
            if (reads < 3) controller.enqueue(Uint8Array.of(1, 2, 3))
            else controller.close()
        },
        cancel,
    }, { highWaterMark: 0 }))
    expect(response.status).toBe(413)
    expect(await response.json()).toMatchObject({ code: 'too_large' })
    expect(reads).toBe(2)
    expect(cancel).toHaveBeenCalledOnce()
})

test('refuses publication once the coworker deletion has been admitted', async () => {
    const db = await openDesktopDatabase(root)
    await db.execute({ sql: 'INSERT INTO desktop_deletions (agent_id, engine_agent_id, name) VALUES (?, ?, ?)', args: [agentId, 'engine-alice', 'Alice'] })
    expect((await send('ok')).status).toBe(409)
    await expect(readFile(join(workspace, 'note.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
})

test('reports cancellation when the body reader rejects during an abort', async () => {
    const abort = new AbortController()
    const response = await send(new ReadableStream({
        pull(controller) {
            controller.error(new Error('Disconnected'))
            abort.abort()
        },
    }, { highWaterMark: 0 }), undefined, abort.signal)
    expect(await response.json()).toMatchObject({ code: 'aborted' })
    await expect(readFile(join(workspace, 'note.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
})

test('publishes exact bytes at the limit and admits an empty file', async () => {
    expect((await send(Uint8Array.of(1, 2, 3, 4))).status).toBe(201)
    const path = join(workspace, 'note.txt')
    expect(await readFile(path)).toEqual(Buffer.from([1, 2, 3, 4]))
    await rm(path)
    expect((await send()).status).toBe(201)
    expect((await readFile(path)).length).toBe(0)
})

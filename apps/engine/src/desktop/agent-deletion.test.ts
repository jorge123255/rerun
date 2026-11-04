import { existsSync, mkdtempSync } from 'node:fs'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, beforeAll, expect, test, vi } from 'vitest'

process.env.RERUN_DATA_DIR = mkdtempSync(join(tmpdir(), 'rerun-delete-engine-'))
process.env.RERUN_DESKTOP_APP = '1'
process.env.RERUN_API_KEY = ''
process.env.RERUN_HUB_BASE_URL = ''
process.env.RERUN_DESKTOP_SECRET_KEY = '2'.repeat(64)

const { createServer } = await import('../http/server.js')
const { migrate } = await import('../db/migrate.js')
const { agentDir, workspaceDir } = await import('../config/paths.js')
const { getAgentIndex } = await import('../db/repos/agents.js')
const { createSession, listSessions } = await import('../db/repos/sessions.js')
const { appendMessage, listMessages } = await import('../db/repos/messages.js')
const { getSystemDb } = await import('../db/systemDb.js')
const { getAgentDb } = await import('../db/agentDb.js')
const { duplicateAgent } = await import('../agents/duplicate.js')
const { withDesktopLearning } = await import('./learning.js')
const { beginDesktopAgentWork, desktopDeletionPath, desktopDeletedPath } = await import('./agent-lifecycle.js')
const app = createServer()

const send = (method: string, path: string, body?: unknown) => app.request(path, {
    method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
})
async function coworker(name: string) {
    const response = await send('POST', '/agents', { config: { name } })
    expect(response.status).toBe(201)
    return (await response.json() as { id: string }).id
}
const remove = (id: string) => send('DELETE', `/agents/${id}`)
const gate = () => {
    let resolve!: () => void
    const promise = new Promise<void>(done => { resolve = done })
    return { promise, resolve }
}
beforeAll(() => migrate())
afterAll(async () => { await rm(process.env.RERUN_DATA_DIR!, { recursive: true, force: true }) })

test('deleting a copy removes only its own files, chats and index; late database opens cannot recreate it', async () => {
    const original = await coworker('original')
    const session = await createSession(original, 'Original chat')
    await appendMessage(original, session.id, { role: 'assistant', content: 'Keep the original reply.' })
    await writeFile(join(workspaceDir(original), 'brief.md'), 'Original brief')
    const requestId = crypto.randomUUID()
    const copy = await duplicateAgent(original, { name: 'original-copy' }, requestId)
    const copyChat = await createSession(copy.id, 'Copy chat')
    await appendMessage(copy.id, copyChat.id, { role: 'assistant', content: 'Delete only the copy.' })
    const before = await listMessages(original, session.id)
    expect((await remove(copy.id)).status).toBe(200)
    expect(existsSync(agentDir(copy.id))).toBe(false)
    expect(existsSync(desktopDeletionPath(copy.id))).toBe(false)
    expect(existsSync(desktopDeletedPath(copy.id))).toBe(true)
    expect(await getAgentIndex(copy.id)).toBeUndefined()
    expect(await listMessages(original, session.id)).toEqual(before)
    expect((await listSessions(original)).map(item => item.id)).toContain(session.id)
    expect(await readFile(join(workspaceDir(original), 'brief.md'), 'utf8')).toBe('Original brief')
    expect((await remove(copy.id)).status).toBe(404)
    await expect(getSystemDb(copy.id)).rejects.toThrow('agent not found')
    await expect(getAgentDb(copy.id)).rejects.toThrow('agent not found')
    await expect(duplicateAgent(original, { name: 'original-copy' }, requestId)).rejects.toThrow('agent not found')
    expect(existsSync(agentDir(copy.id))).toBe(false)
})

test('an admitted request blocks deletion before a run or config write is stored', async () => {
    const id = await coworker('pending-request')
    const reading = gate(), body = gate()
    let delivered = false
    const stream = new ReadableStream<Uint8Array>({ async pull(controller) {
        if (delivered) return
        delivered = true
        reading.resolve()
        await body.promise
        controller.enqueue(new TextEncoder().encode(JSON.stringify({ description: 'Still here' })))
        controller.close()
    } }, { highWaterMark: 0 })
    const patch = app.request(new Request(`http://localhost/agents/${id}`, {
        method: 'PATCH', headers: { 'content-type': 'application/json' }, body: stream, duplex: 'half',
    } as RequestInit))
    await reading.promise
    try {
        expect((await remove(id)).status).toBe(409)
        expect(existsSync(agentDir(id))).toBe(true)
    } finally { body.resolve() }
    expect((await patch).status).toBe(200)
    expect((await remove(id)).status).toBe(200)
})

test('unfinished run settlement and learning block only their coworker until all writes finish', async () => {
    const working = await coworker('working')
    const idle = await coworker('idle')
    const release = beginDesktopAgentWork(working)
    expect((await remove(working)).status).toBe(409)
    expect((await remove(idle)).status).toBe(200)
    release()
    const started = gate(), finish = gate()
    const review = withDesktopLearning(working, async () => { started.resolve(); await finish.promise })
    await started.promise
    try { expect((await remove(working)).status).toBe(409) }
    finally { finish.resolve() }
    await review
    expect((await remove(working)).status).toBe(200)
})

test('an interrupted removal is unavailable to readers and retry finishes the owned pending folder', async () => {
    const id = await coworker('interrupted')
    const pending = desktopDeletionPath(id)
    await mkdir(dirname(pending), { recursive: true })
    await rename(agentDir(id), pending)
    await rm(join(pending, 'config.json'))
    await writeFile(join(pending, 'retained-data.txt'), 'Residue must not be accepted as deleted')
    expect((await send('GET', `/agents/${id}`)).status).toBe(409)
    expect((await send('GET', `/agents/${id}/sessions`)).status).toBe(409)
    expect((await remove(id)).status).toBe(200)
    expect(existsSync(pending)).toBe(false)
    expect((await send('GET', `/agents/${id}`)).status).toBe(404)
    expect((await remove(id)).status).toBe(404)
})

test('a completed copy can be replayed after deleting its original without restoring the original', async () => {
    const original = await coworker('replay-source')
    const requestId = crypto.randomUUID()
    const copy = await duplicateAgent(original, { name: 'kept-copy' }, requestId)
    expect((await remove(original)).status).toBe(200)
    const response = await app.request(`/agents/${original}/duplicate`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-rerun-duplicate-id': requestId },
        body: JSON.stringify({ name: 'kept-copy' }),
    })
    expect(response.status).toBe(201)
    expect((await response.json() as { id: string }).id).toBe(copy.id)
    expect(existsSync(agentDir(original))).toBe(false)
    expect(existsSync(agentDir(copy.id))).toBe(true)
})

test('a fresh lifecycle module rejects the durable deleted identity after its in-memory state is gone', async () => {
    const id = await coworker('durable-deletion')
    expect((await remove(id)).status).toBe(200)
    vi.resetModules()
    const fresh = await import('./agent-lifecycle.js')
    expect(() => fresh.beginDesktopAgentWork(id)).toThrow('agent not found')
    expect(existsSync(agentDir(id))).toBe(false)
})

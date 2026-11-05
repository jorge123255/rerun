import { mkdtempSync } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { contextTextPart } from '@rerun/contracts'

process.env.RERUN_DATA_DIR = mkdtempSync(join(tmpdir(), 'rerun-first-turn-'))
process.env.RERUN_HUB_BASE_URL = ''
const { getSystemDb, closeSystemDb } = await import('../systemDb.js')
const { agentDir } = await import('../../config/paths.js')
const { startDesktopTabRun, getDesktopTabRun } = await import('./desktop-tab-runs.js')
const { listMessages, completeQueuedUser } = await import('./messages.js')
const { getRun } = await import('./runs.js')
const { getSession } = await import('./sessions.js')
const id = 'first-turn-owner'
const turn = () => ({ sessionId: crypto.randomUUID(), runId: crypto.randomUUID(), message: 'Keep this exact first message.', author: { id: 'local-user', name: 'Local User' } })
beforeAll(async () => { await mkdir(agentDir(id), { recursive: true }); await getSystemDb(id) })
afterAll(async () => { closeSystemDb(id); await rm(process.env.RERUN_DATA_DIR!, { recursive: true, force: true }) })

test('simultaneous admission persists one run, user snapshot and receipt; context enriches the same row', async () => {
    const input = { ...turn(), attachments: [{ path: 'brief.md', content: 'Frozen file content' }] }
    const admitted = await Promise.all([startDesktopTabRun(id, input), startDesktopTabRun(id, input)])
    expect(admitted.filter(Boolean)).toHaveLength(1)
    const saved = admitted.find(Boolean)!
    const before = await listMessages(id, input.sessionId)
    expect(before).toHaveLength(1)
    expect(before[0].id).toBe(saved.id)
    expect(before[0].contentJson).toContain('Frozen file content')
    expect(await getRun(id, input.runId)).toMatchObject({ sessionId: input.sessionId })
    const content = [...JSON.parse(saved.contentJson), contextTextPart('Recall added during preparation')]
    await completeQueuedUser(id, saved, content)
    expect(await getDesktopTabRun(id, input)).toBe(true)
    expect(await startDesktopTabRun(id, input)).toBeNull()
    expect((await listMessages(id, input.sessionId)).map(row => row.id)).toEqual([saved.id])
    const { client } = await getSystemDb(id)
    const indexed = await client.execute({ sql: 'SELECT message_id FROM messages_fts WHERE message_id=?', args: [saved.id] })
    expect(indexed.rows).toHaveLength(1)
})

test('the admitted input survives a closed/reopened database even if no runner ever began', async () => {
    const input = turn()
    const saved = await startDesktopTabRun(id, input)
    closeSystemDb(id)
    expect(await getDesktopTabRun(id, input)).toBe(true)
    expect(await startDesktopTabRun(id, input)).toBeNull()
    const messages = await listMessages(id, input.sessionId)
    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatchObject({ id: saved!.id, authorId: input.author.id })
    expect(JSON.parse(messages[0].contentJson)[0].text).toBe(input.message)
})

test('failed user persistence rolls back the session, run and receipt together', async () => {
    const input = turn()
    const { client } = await getSystemDb(id)
    await client.execute("CREATE TRIGGER fail_first_user BEFORE INSERT ON messages BEGIN SELECT RAISE(ABORT,'first user unavailable'); END")
    try {
        await expect(startDesktopTabRun(id, input)).rejects.toThrow('first user unavailable')
        expect(await getSession(id, input.sessionId)).toBeUndefined()
        expect(await getRun(id, input.runId)).toBeUndefined()
        expect(await getDesktopTabRun(id, input)).toBe(false)
    } finally { await client.execute('DROP TRIGGER fail_first_user') }
    expect(await startDesktopTabRun(id, input)).not.toBeNull()
    expect(await listMessages(id, input.sessionId)).toHaveLength(1)
})

test('a receipt binds exact text, file snapshots, author and both IDs', async () => {
    const input = { ...turn(), attachments: [{ path: 'brief.md', content: 'Version one' }] }
    await startDesktopTabRun(id, input)
    for (const changed of [
        { ...input, message: 'Different text' },
        { ...input, attachments: [{ path: 'brief.md', content: 'Version two' }] },
        { ...input, author: { ...input.author, id: 'other-user' } },
        { ...input, sessionId: crypto.randomUUID() },
        { ...input, runId: crypto.randomUUID() },
    ]) await expect(startDesktopTabRun(id, changed)).rejects.toMatchObject({ status: 409 })
    expect(await listMessages(id, input.sessionId)).toHaveLength(1)
})

test('missing accepted user rows and legacy empty runs cannot falsely acknowledge delivery', async () => {
    const input = turn()
    const saved = await startDesktopTabRun(id, input)
    const { client } = await getSystemDb(id)
    await client.execute({ sql: 'DELETE FROM messages WHERE id=?', args: [saved!.id] })
    await expect(getDesktopTabRun(id, input)).rejects.toMatchObject({ status: 409 })
    await expect(startDesktopTabRun(id, input)).rejects.toMatchObject({ status: 409 })
    expect(await listMessages(id, input.sessionId)).toHaveLength(0)
    const legacy = turn(), now = new Date().toISOString()
    await client.batch([
        { sql: 'INSERT INTO sessions(id,agent_id,created_at,updated_at) VALUES(?,?,?,?)', args: [legacy.sessionId,id,now,now] },
        { sql: 'INSERT INTO runs(id,agent_id,session_id,started_at) VALUES(?,?,?,?)', args: [legacy.runId,id,legacy.sessionId,now] },
    ], 'write')
    await expect(startDesktopTabRun(id, legacy)).rejects.toMatchObject({ status: 409 })
    expect(await listMessages(id, legacy.sessionId)).toHaveLength(0)
})

test('a matching legacy single-run user row can be replayed without appending or invoking another run', async () => {
    const input = turn()
    const saved = await startDesktopTabRun(id, input)
    const { client } = await getSystemDb(id)
    await client.execute({ sql: 'DELETE FROM desktop_first_turns WHERE run_id=?', args: [input.runId] })
    expect(await getDesktopTabRun(id, input)).toBe(true)
    expect(await startDesktopTabRun(id, input)).toBeNull()
    expect((await listMessages(id, input.sessionId)).map(row => row.id)).toEqual([saved!.id])
    await expect(startDesktopTabRun(id, { ...input, message: 'Changed legacy input' })).rejects.toMatchObject({ status: 409 })
})

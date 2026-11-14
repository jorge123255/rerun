import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createClient, type Client } from '@libsql/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { FOREMAN_AGENT_ID } from '@rerun/contracts'

vi.mock('server-only', () => ({}))
const { connectorCallerNote, connectorCallerOf, tellConnectorCaller } = await import('./tell-caller')

let db: Client, dir: string
beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'tell-caller-'))
    db = createClient({ url: `file:${join(dir, 'app.db')}` })
})
afterEach(async () => { db.close(); await rm(dir, { recursive: true, force: true }) })
const ports = () => ({ coworker: vi.fn(async () => {}), foreman: vi.fn(async () => {}) })
async function calls(rows: [string, string, string, string, string][]) {
    await db.execute('CREATE TABLE desktop_coworker_calls (call_id TEXT PRIMARY KEY, parent_agent_id TEXT, parent_session_id TEXT, target_session_id TEXT, target_name TEXT, created_at TEXT)')
    for (const [id, agent, session, target, at] of rows) await db.execute({ sql: 'INSERT INTO desktop_coworker_calls VALUES(?,?,?,?,?,?)', args: [id, agent, session, target, 'Prior App QA', at] })
}

test('a chat nobody called has no caller, even before any call was ever made', async () => {
    const port = ports()
    expect(await connectorCallerOf(db, 'chat-1')).toBeNull()
    await calls([['c1', 'coworker-2', 'caller-chat', 'other-chat', '2026-11-14T10:00:00.000Z']])
    expect(await tellConnectorCaller(db, 'chat-1', { tool: 'notes_send_note', decision: 'once' }, port)).toBe(false)
    expect(port.coworker).not.toHaveBeenCalled()
    expect(port.foreman).not.toHaveBeenCalled()
})

test('the calling coworker gets a turn saying what was answered', async () => {
    await calls([['c1', 'coworker-2', 'caller-chat', 'chat-1', '2026-11-14T10:00:00.000Z']])
    const port = ports()
    expect(await tellConnectorCaller(db, 'chat-1', { tool: 'notes_send_note', decision: 'once' }, port)).toBe(true)
    expect(port.coworker).toHaveBeenCalledWith('coworker-2', 'caller-chat', 'Rerun note: the person allowed "Notes Send Note" for Prior App QA. Prior App QA is running it now in its own chat; its result is there, not here. Tell the person briefly that it is under way.')
    expect(await tellConnectorCaller(db, 'chat-1', { tool: 'notes_send_note', decision: 'deny' }, port)).toBe(true)
    expect(port.coworker).toHaveBeenLastCalledWith('coworker-2', 'caller-chat', expect.stringMatching(/declined "Notes Send Note" for Prior App QA\. It did not run\./))
    expect(port.foreman).not.toHaveBeenCalled()
})

test('the Chief of Staff is told in its own conversation', async () => {
    await calls([['c1', FOREMAN_AGENT_ID, 'foreman-chat', 'chat-1', '2026-11-14T10:00:00.000Z']])
    const port = ports()
    expect(await tellConnectorCaller(db, 'chat-1', { tool: 'gmail_send_email', decision: 'always' }, port)).toBe(true)
    expect(port.foreman).toHaveBeenCalledWith('foreman-chat', expect.stringMatching(/^[0-9a-f-]{36}$/), expect.stringContaining('allowed "Gmail Send Email"'))
    expect(port.coworker).not.toHaveBeenCalled()
})

test('a caller that cannot be reached is simply not told', async () => {
    await calls([['c1', 'coworker-2', 'caller-chat', 'chat-1', '2026-11-14T10:00:00.000Z']])
    const port = { coworker: vi.fn(async () => { throw new Error('busy') }), foreman: vi.fn(async () => {}) }
    expect(await tellConnectorCaller(db, 'chat-1', { tool: 'notes_send_note', decision: 'once' }, port)).toBe(false)
    expect(connectorCallerNote('drive_delete_file', 'conversation', 'Pat')).toContain('allowed "Drive Delete File" for Pat')
})

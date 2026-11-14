import { createClient } from '@libsql/client'
import type { Message } from '@rerun/contracts'
import { randomUUID } from 'node:crypto'
import { expect, test, vi } from 'vitest'
import { lastMessageOf, readDesktopCoworkerPreviews, type CoworkerPreviewEngine } from './coworker-previews'

vi.mock('server-only', () => ({}))

const message = (role: Message['role'], content: unknown): Message => ({ id: randomUUID(), sessionId: 's', role, contentJson: JSON.stringify(content), toolCallsJson: null, createdAt: '' })

async function fixture() {
    const db = createClient({ url: ':memory:' })
    await db.executeMultiple(`
        CREATE TABLE desktop_agents (id TEXT PRIMARY KEY, engine_agent_id TEXT, workspace_id INTEGER NOT NULL);
        CREATE TABLE desktop_deletions (agent_id TEXT NOT NULL, completed INTEGER NOT NULL);
        CREATE TABLE desktop_sessions (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, engine_session_id TEXT NOT NULL, title TEXT NOT NULL, updated_at TEXT NOT NULL);`)
    const [ann, bo, quiet, leaving, foreign] = Array.from({ length: 5 }, () => randomUUID())
    await db.batch([ann, bo, quiet, leaving, foreign].map((id, index) => ({ sql: 'INSERT INTO desktop_agents VALUES(?,?,?)', args: [id, 'engine-' + index, index === 4 ? 2 : 1] })), 'write')
    await db.execute({ sql: 'INSERT INTO desktop_deletions VALUES(?,0)', args: [leaving] })
    const session = (id: string, agent: string, title: string, at: string) => ({ sql: 'INSERT INTO desktop_sessions VALUES(?,?,?,?,?)', args: [id, agent, 'e-' + id, title, at] })
    await db.batch([
        session('a1', ann, 'Older here, newer in the engine', '2026-11-12T09:00:00.000Z'), session('a2', ann, 'Q4 prospects', '2026-11-13T10:00:00.000Z'),
        session('b1', bo, 'Tie, lower id', '2026-11-13T08:00:00.000Z'), session('b2', bo, 'Tie, higher id', '2026-11-13T08:00:00.000Z'),
        session('l1', leaving, 'Leaving', '2026-11-13T11:00:00.000Z'), session('f1', foreign, 'Other workspace', '2026-11-13T12:00:00.000Z'),
    ], 'write')
    return { db, ann, bo }
}

test('without the engine, returns each coworker\'s most recently saved conversation and none for a coworker being removed', async () => {
    const { db, ann, bo } = await fixture()
    try {
        expect(await readDesktopCoworkerPreviews(db)).toEqual({ previews: {
            [ann]: { title: 'Q4 prospects', updatedAt: '2026-11-13T10:00:00.000Z' },
            [bo]: { title: 'Tie, higher id', updatedAt: '2026-11-13T08:00:00.000Z' },
        } })
    } finally { db.close() }
})

test('the engine says which conversation moved last and what was said in it; a failed read falls back to what is saved', async () => {
    const { db, ann, bo } = await fixture()
    try {
        const asked: string[] = []
        const engine: CoworkerPreviewEngine = {
            async sessions(agent) {
                if (agent === 'engine-1') throw new Error('engine unavailable')
                return [{ id: 'e-a1', updatedAt: '2026-11-13T15:00:00.000Z' }, { id: 'e-a2', updatedAt: '2026-11-13T10:30:00.000Z' }, { id: 'unknown-here', updatedAt: '2026-11-13T23:00:00.000Z' }]
            },
            async messages(agent, session) {
                asked.push(agent + '/' + session)
                return [message('user', 'Find **three** leads'), message('assistant', [{ type: 'text', text: 'Here are the [three leads](https://x.test/s).' }]), message('tool', [{ type: 'tool-result', toolCallId: 'c', output: 'raw' }])]
            },
        }
        expect(await readDesktopCoworkerPreviews(db, engine)).toEqual({ previews: {
            [ann]: { title: 'Older here, newer in the engine', updatedAt: '2026-11-13T15:00:00.000Z', lastMessage: { text: 'Here are the three leads.', mine: false } },
            [bo]: { title: 'Tie, higher id', updatedAt: '2026-11-13T08:00:00.000Z' },
        } })
        expect(asked).toEqual(['engine-0/e-a1'])
    } finally { db.close() }
})

test('the last message is the last words said: the person\'s own, or the coworker\'s, never a tool row or an empty turn', () => {
    expect(lastMessageOf([])).toBeNull()
    expect(lastMessageOf([message('assistant', 'Done.'), message('user', { text: 'Thanks, ship it' })])).toEqual({ text: 'Thanks, ship it', mine: true })
    expect(lastMessageOf([message('user', 'Start'), message('assistant', [{ type: 'tool-call', toolCallId: 'c' }]), message('tool', 'x')])).toEqual({ text: 'Start', mine: true })
})

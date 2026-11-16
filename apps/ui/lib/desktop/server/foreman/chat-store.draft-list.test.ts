import { createClient } from '@libsql/client'
import { expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))
import { foremanConversationColumns, listForemanConversations } from './chat-store'

it('lists a task that only holds unsent words as having a draft, so it can be found again', async () => {
    const db = createClient({ url: ':memory:' })
    await db.executeMultiple(`CREATE TABLE desktop_foreman_chats(${foremanConversationColumns});
        CREATE TABLE desktop_foreman_turns(chat_id TEXT NOT NULL, created_at TEXT NOT NULL, body TEXT);`)
    const add = (id: string, home: number, ui: string | null) => db.execute({ sql: 'INSERT INTO desktop_foreman_chats(chat_id,workspace_id,engine_session_id,home,ui) VALUES(?,?,?,?,?)', args: [id, '1', `session-${id}`, home, ui] })
    await add('fmc_home', 1, JSON.stringify({ draft: '' }))
    await add('fmc_typed', 0, JSON.stringify({ draft: 'Plan the launch' }))
    await add('fmc_blank', 0, JSON.stringify({ draft: '   ' }))
    await add('fmc_nothing', 0, null)
    await add('fmc_broken', 0, '{not json')
    const rows = await listForemanConversations(db, '1')
    const drafts = Object.fromEntries(rows.map(row => [row.chat.chatId, 'hasDraft' in row && row.hasDraft === true]))
    expect(drafts).toEqual({ fmc_home: false, fmc_typed: true, fmc_blank: false, fmc_nothing: false, fmc_broken: false })
})

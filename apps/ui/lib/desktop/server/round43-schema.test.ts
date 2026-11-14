import { createClient } from '@libsql/client'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import type { DesktopRuntime } from './runtime'
import { initializeDesktopRound43 } from './round43-schema'
import { createForemanConversation, ensureForemanChat, LEGACY_DESKTOP_FOREMAN_CHAT_SCHEMA, listForemanConversations, ownedForemanChat } from './foreman/chat-store'
import { setDesktopWorkspaceFrozen } from './workspace-admission'

test('upgrades the original chat and dependent rows, then reopens distinct conversations with one exact saved prompt', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rerun-foreman-conversations-'))
    const open = () => createClient({ url: `file:${join(dir, 'app.db')}` })
    let db = open()
    const runtime: DesktopRuntime = { protocolVersion: 1, workspaceId: 1, launchNonce: randomUUID(), buildId: 'fixture',
        dataRoot: dir, app: { origin: 'http://127.0.0.1:1', sessionToken: 'a'.repeat(64) },
        engine: { origin: 'http://127.0.0.1:2', apiKey: 'b'.repeat(64) } }
    const home = { workspaceId: '1', chatId: 'fmc_original-quick-fixture' }
    const requestId = randomUUID()
    try {
        await db.executeMultiple(`PRAGMA foreign_keys=ON;
            CREATE TABLE desktop_schema_migrations(version INTEGER PRIMARY KEY, id TEXT NOT NULL);
            ${LEGACY_DESKTOP_FOREMAN_CHAT_SCHEMA}
            CREATE TABLE fixture_attachment(chat_id TEXT REFERENCES desktop_foreman_chats(chat_id) ON DELETE CASCADE, bytes BLOB);
            INSERT INTO desktop_foreman_chats VALUES('${home.chatId}','1','original-engine-session',NULL,'{"draft":"Keep me"}',4);
            INSERT INTO desktop_foreman_turns VALUES('old-turn','${home.chatId}','receipt','{}','finished','2026-11-06',NULL);
            INSERT INTO fixture_attachment VALUES('${home.chatId}',X'ABCD');`)
        await initializeDesktopRound43(db)
        expect((await ensureForemanChat(db, '1')).chat).toEqual(home)
        expect((await db.execute('SELECT ui,ui_revision FROM desktop_foreman_chats WHERE home=1')).rows).toEqual([{ ui: '{"draft":"Keep me"}', ui_revision: 4 }])
        expect((await db.execute('SELECT request_id FROM desktop_foreman_turns')).rows[0].request_id).toBe('old-turn')
        expect((await db.execute('SELECT hex(bytes) AS bytes FROM fixture_attachment')).rows[0].bytes).toBe('ABCD')
        const prompt = 'Test the   separate conversation'
        const chat = await createForemanConversation(db, runtime, requestId, prompt)
        expect(await createForemanConversation(db, runtime, requestId, prompt)).toEqual(chat)
        await expect(createForemanConversation(db, runtime, requestId, 'Different text')).rejects.toMatchObject({ status: 409 })
        await expect(ownedForemanChat(db, { ...chat, workspaceId: '2' })).rejects.toMatchObject({ status: 404 })
        const other = await createForemanConversation(db, runtime, randomUUID())
        expect((await ownedForemanChat(db, chat)).sessionId).not.toBe((await ownedForemanChat(db, other)).sessionId)
        expect((await ownedForemanChat(db, chat)).sessionId).not.toBe('original-engine-session')
        setDesktopWorkspaceFrozen(runtime, true)
        await expect(createForemanConversation(db, runtime, randomUUID())).rejects.toMatchObject({ status: 409 })
        db.close()
        db = open()
        await initializeDesktopRound43(db)
        expect((await db.execute('PRAGMA foreign_key_check')).rows).toEqual([])
        expect(await listForemanConversations(db, '1')).toEqual([
            { chat: home, home: true, title: null },
            { chat: other, home: false, title: null },
            { chat, home: false, title: 'Test the separate conversation' },
        ])
        expect(await listForemanConversations(db, '2')).toEqual([])
        const { rows: [saved] } = await db.execute({ sql: 'SELECT ui FROM desktop_foreman_chats WHERE chat_id=?', args: [chat.chatId] })
        expect(JSON.parse(String(saved.ui)).pendingSend).toEqual({ requestId, text: prompt, modelChoice: null })
        expect((await ensureForemanChat(db, '1')).sessionId).toBe('original-engine-session')
    } finally {
        db.close()
        await rm(dir, { recursive: true, force: true })
    }
})

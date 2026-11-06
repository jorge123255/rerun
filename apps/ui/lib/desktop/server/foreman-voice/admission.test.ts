import { createClient } from '@libsql/client'
import { expect, test, vi } from 'vitest'
import { assertForemanVoiceAdmission } from './admission'
import { FOREMAN_VOICE_SCHEMA_SQL, voiceScope, voiceTargetJson } from './store'
const target = { chat: { workspaceId: '1', chatId: 'fmc_00000000-0000-4000-8000-000000000002' }, model: { connectionId: 'c', model: 'm' } }
const id = '00000000-0000-4000-8000-000000000001'
const turn = { binding: { ...target.chat, model: target.model, runId: id }, sessionId: '00000000-0000-4000-8000-000000000004', text: 'Only the recording', brief: { instructions: 'Foreman', tools: [] } }
test('the engine callback fence refuses a cancelled, substituted or concurrently replaced recording', async () => {
    const db = createClient({ url: ':memory:' })
    try {
        await db.executeMultiple('CREATE TABLE desktop_foreman_chats(chat_id TEXT PRIMARY KEY);' + FOREMAN_VOICE_SCHEMA_SQL)
        const record = { draft: { attemptId: id, scope: voiceScope(target), revision: id, phase: 'sending', transcript: turn.text, error: null, messageId: null, updatedAt: 'now', recording: { attemptId: id, sha256: 'a'.repeat(64), byteLength: 1, mimeType: 'audio/webm', extension: 'webm', transcriptionFormat: 'webm', durationMs: 900, levels: [] } } }
        await db.execute({ sql: 'INSERT INTO desktop_foreman_voice_attempts(attempt_id,chat_id,target,record,fingerprint,send_requested) VALUES(?,?,?,?,?,1)', args: [id, target.chat.chatId, voiceTargetJson(target), JSON.stringify(record), 'fingerprint'] })
        const owner = vi.fn(async () => {})
        await assertForemanVoiceAdmission(db, turn, owner)
        await expect(assertForemanVoiceAdmission(db, { ...turn, text: 'Typed draft accidentally appended' }, owner)).rejects.toThrow()
        await expect(assertForemanVoiceAdmission(db, { ...turn, binding: { ...turn.binding, model: { ...target.model, model: 'other' } } }, owner)).rejects.toThrow()
        await expect(assertForemanVoiceAdmission(db, turn, async () => { await db.execute('UPDATE desktop_foreman_voice_attempts SET epoch=epoch+1,cancelled=1') })).rejects.toThrow()
        await expect(assertForemanVoiceAdmission(db, turn, owner)).rejects.toThrow()
    } finally { db.close() }
})
test('ordinary Foreman text admission is delegated unchanged when no voice identity exists', async () => {
    const db = createClient({ url: ':memory:' })
    try {
        await db.executeMultiple('CREATE TABLE desktop_foreman_chats(chat_id TEXT PRIMARY KEY);' + FOREMAN_VOICE_SCHEMA_SQL)
        const owner = vi.fn(async () => {})
        await assertForemanVoiceAdmission(db, turn, owner)
        expect(owner).not.toHaveBeenCalled()
    } finally { db.close() }
})

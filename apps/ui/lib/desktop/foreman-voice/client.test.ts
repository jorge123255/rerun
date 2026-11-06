import { expect, test } from 'vitest'
import { foremanVoiceRequestSchema, foremanVoiceSnapshotSchema } from '../../../../../packages/contracts/src/desktop-foreman-voice'
import { createForemanVoiceClient } from './client'
const id = '00000000-0000-4000-8000-000000000001'
const target = { chat: { workspaceId: '1', chatId: 'fmc_00000000-0000-4000-8000-000000000002' }, model: { connectionId: 'connection', model: 'model' } }
test('public protocol refuses private engine fields and an unrelated acceptance receipt', () => {
    expect(foremanVoiceRequestSchema.safeParse({ action: 'read', target, attemptId: id, sessionId: 'private' }).success).toBe(false)
    expect(foremanVoiceSnapshotSchema.safeParse({ target, attempt: null, receipt: { target, attemptId: id, requestId: id, runId: id, accepted: true }, setup: null }).success).toBe(false)
})
test('client rejects a stale workspace/chat/model acknowledgement', async () => {
    for (const stale of [
        { ...target, chat: { ...target.chat, workspaceId: '2' } },
        { ...target, chat: { ...target.chat, chatId: 'fmc_00000000-0000-4000-8000-000000000003' } },
        { ...target, model: { ...target.model, model: 'other' } },
    ]) {
        const fetcher = (async () => Response.json({ target: stale, attempt: null, receipt: null, setup: null })) as typeof fetch
        await expect(createForemanVoiceClient(fetcher).request({ action: 'read', target, attemptId: id }, new AbortController().signal)).rejects.toThrow()
    }
})
test('status errors and oversized replies do not become successful empty transcripts', async () => {
    const unavailable = (async () => Response.json({ error: 'unavailable' }, { status: 503 })) as typeof fetch
    await expect(createForemanVoiceClient(unavailable).request({ action: 'read', target, attemptId: id }, new AbortController().signal)).rejects.toThrow()
    const oversized = (async () => new Response('x'.repeat(400_001))) as typeof fetch
    await expect(createForemanVoiceClient(oversized).request({ action: 'read', target, attemptId: id }, new AbortController().signal)).rejects.toThrow()
})

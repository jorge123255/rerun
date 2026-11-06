import { expect, test } from 'vitest'
import { foremanVoiceRequestSchema, foremanVoiceSnapshotSchema } from '@rerun/contracts'
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
        { ...target, model: { ...target.model, connectionId: 'other' } },
    ]) {
        const fetcher = (async () => Response.json({ target: stale, attempt: null, receipt: null, setup: null })) as typeof fetch
        await expect(createForemanVoiceClient(fetcher).request({ action: 'read', target, attemptId: id }, new AbortController().signal)).rejects.toThrow()
        await expect(createForemanVoiceClient(fetcher).recover(target, new AbortController().signal)).rejects.toThrow()
    }
})
test('discovery uses only exact target metadata in a read-only request and rejects oversized or unavailable snapshots', async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = []
    const fetcher = (async (url, init) => { calls.push({ url: String(url), init }); return Response.json({ target, attempt: null, receipt: null, setup: null }) }) as typeof fetch
    expect((await createForemanVoiceClient(fetcher).recover(target, new AbortController().signal)).attempt).toBeNull()
    const query = new URL(calls[0].url, 'http://127.0.0.1').searchParams
    expect(Object.fromEntries(query)).toEqual({ workspaceId: target.chat.workspaceId, chatId: target.chat.chatId, connectionId: target.model.connectionId, model: target.model.model, view: 'pending' })
    expect(calls[0].init?.body).toBeUndefined(); expect(calls[0].init?.method).toBeUndefined(); expect(calls[0].init?.cache).toBe('no-store')
    await expect(createForemanVoiceClient((async () => new Response('x'.repeat(400_001))) as typeof fetch).recover(target, new AbortController().signal)).rejects.toThrow()
    await expect(createForemanVoiceClient((async () => Response.json({ error: 'unavailable' }, { status: 503 })) as typeof fetch).recover(target, new AbortController().signal)).rejects.toThrow()
})
test('status errors and oversized replies do not become successful empty transcripts', async () => {
    const unavailable = (async () => Response.json({ error: 'unavailable' }, { status: 503 })) as typeof fetch
    await expect(createForemanVoiceClient(unavailable).request({ action: 'read', target, attemptId: id }, new AbortController().signal)).rejects.toThrow()
    const oversized = (async () => new Response('x'.repeat(400_001))) as typeof fetch
    await expect(createForemanVoiceClient(oversized).request({ action: 'read', target, attemptId: id }, new AbortController().signal)).rejects.toThrow()
})

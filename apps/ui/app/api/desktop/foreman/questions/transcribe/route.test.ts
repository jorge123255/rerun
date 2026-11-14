import { createHash, randomUUID } from 'node:crypto'
import { createClient, type Client } from '@libsql/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { request as engineRequest } from '@/lib/engine/client'
import { desktopAuxiliarySchema, desktopAuxiliaryStore } from '@/lib/desktop/server/auxiliary/store'
import { DESKTOP_FOREMAN_CHAT_SCHEMA } from '@/lib/desktop/server/foreman/chat-store'
import type { DesktopRuntime } from '@/lib/desktop/server/runtime'
import { setDesktopWorkspaceFrozen } from '@/lib/desktop/server/workspace-admission'
import { POST } from './route'

const state = vi.hoisted(() => ({ runtime: null as DesktopRuntime | null, db: null as Client | null }))
vi.mock('@/lib/desktop/server/runtime', async original => ({
    ...await original<typeof import('@/lib/desktop/server/runtime')>(), readDesktopRuntime: async () => state.runtime!,
}))
vi.mock('@/lib/desktop/server/database', () => ({ openDesktopDatabase: async () => state.db! }))
vi.mock('@/lib/engine/client', () => ({ request: vi.fn() }))

const origin = 'http://127.0.0.1:43100', token = 's'.repeat(48)
const chat = { workspaceId: '1', chatId: 'fmc_dictationfixture' }
const sessionId = randomUUID()
const guard = { runId: randomUUID(), sourceMessageId: 'question-message', toolCallId: 'question-call', digest: 'd'.repeat(64) }
const question = { guard, questions: [{ question: 'Which time?', options: ['Morning', 'Afternoon'] }] }
const questionId = createHash('sha256').update(JSON.stringify([chat.workspaceId, chat.chatId, sessionId,
    guard.runId, guard.sourceMessageId, guard.toolCallId, guard.digest])).digest('hex')
const audioBase64 = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.from('webm fixture bytes')]).toString('base64')
const input = { chat, questionId, audioBase64, durationMs: 1000, levels: [],
    format: { mimeType: 'audio/webm', extension: 'webm', transcriptionFormat: 'webm' } }
const provider = vi.fn<typeof fetch>()
function submit(body: unknown = input, cookie = true) {
    return POST(new Request(origin + '/api/desktop/foreman/questions/transcribe', {
        method: 'POST', body: JSON.stringify(body), headers: {
            host: new URL(origin).host, origin, 'content-type': 'application/json',
            ...(cookie && { cookie: `rerun-desktop-session=${token}` }),
        },
    }))
}

beforeEach(async () => {
    state.runtime = { protocolVersion: 1, workspaceId: 1, dataRoot: '/fixture-foreman-voice', launchNonce: randomUUID(), buildId: 'voice-fixture',
        app: { origin, sessionToken: token }, engine: { origin: 'http://127.0.0.1:43101', apiKey: 'engine-fixture' } }
    state.db = createClient({ url: 'file::memory:' })
    await state.db.executeMultiple(DESKTOP_FOREMAN_CHAT_SCHEMA + desktopAuxiliarySchema)
    await state.db.execute({ sql: 'INSERT INTO desktop_foreman_chats(chat_id,workspace_id,engine_session_id) VALUES(?,?,?)',
        args: [chat.chatId, chat.workspaceId, sessionId] })
    vi.stubEnv('RERUN_DESKTOP_SECRET_KEY', 'a'.repeat(64))
    await desktopAuxiliaryStore(state.db).change({ purpose: 'transcription', expectedRevision: 'unconfigured', key: 'synthetic-voice-key' })
    vi.mocked(engineRequest).mockReset().mockImplementation(async (_engine, path, _init, parse) => {
        expect(path).toBe('/desktop/foreman/question?sessionId=' + sessionId)
        return parse({ question })
    })
    provider.mockReset().mockImplementation(async (url, options) => {
        expect(url).toBe('https://openrouter.ai/api/v1/audio/transcriptions')
        expect(JSON.parse(String(options?.body)).input_audio).toEqual({ data: audioBase64, format: 'webm' })
        return Response.json({ text: '  Tomorrow morning.  ' })
    })
    vi.stubGlobal('fetch', provider)
})

afterEach(() => {
    setDesktopWorkspaceFrozen(state.runtime!, false)
    state.db!.close()
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
})

it('returns editable text for the exact pending question without writing an answer or a turn', async () => {
    const response = await submit()
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(await response.json()).toEqual({ transcript: 'Tomorrow morning.' })
    expect(engineRequest).toHaveBeenCalledTimes(2)
    expect(provider).toHaveBeenCalledOnce()
    expect((await state.db!.execute('SELECT request_id FROM desktop_foreman_turns')).rows).toHaveLength(0)
})

it('rejects unauthenticated, foreign, stale and invalid recordings before calling the provider', async () => {
    expect((await submit(input, false)).status).toBe(401)
    expect((await submit({ ...input, chat: { ...chat, workspaceId: '2' } })).status).toBe(404)
    expect((await submit({ ...input, chat: { ...chat, chatId: 'fmc_differentchat' } })).status).toBe(404)
    expect((await submit({ ...input, questionId: 'f'.repeat(64) })).status).toBe(409)
    expect((await submit({ ...input, audioBase64: Buffer.from('invalid audio').toString('base64') })).status).toBe(400)
    expect(provider).not.toHaveBeenCalled()
})

it('discards a late transcript once an answer is reserved and refuses subsequent recording', async () => {
    provider.mockImplementationOnce(async () => {
        await state.db!.execute({ sql: 'INSERT INTO desktop_foreman_turns VALUES(?,?,?,?,?,?,NULL)',
            args: [randomUUID(), chat.chatId, 'answer-fingerprint', JSON.stringify({ answerIntent: { questionId } }), 'pending', new Date().toISOString()] })
        return Response.json({ text: 'Do not return this late transcript' })
    })
    const response = await submit()
    expect(response.status).toBe(409)
    expect(await response.text()).not.toContain('late transcript')
    expect((await submit()).status).toBe(409)
    expect(provider).toHaveBeenCalledOnce()
})

it('discards a late transcript when the workspace begins switching', async () => {
    provider.mockImplementationOnce(async () => {
        setDesktopWorkspaceFrozen(state.runtime!, true)
        return Response.json({ text: 'Do not return this late transcript' })
    })
    const response = await submit()
    expect(response.status).toBe(409)
    expect(await response.text()).not.toContain('late transcript')
    expect((await submit()).status).toBe(409)
    expect(provider).toHaveBeenCalledOnce()
})

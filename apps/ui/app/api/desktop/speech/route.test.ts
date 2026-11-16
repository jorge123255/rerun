import { createServer, type Server } from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DESKTOP_SPEECH_DEFAULT_VOICE, DESKTOP_SPEECH_MAX_CHARS, DESKTOP_SPEECH_PREVIEW_SENTENCE } from '@/lib/desktop/speech'
import { desktopAuxiliaryStore } from '@/lib/desktop/server/auxiliary/store'
import { closeDesktopDatabase, openDesktopDatabase } from '@/lib/desktop/server/database'
import { clearDesktopSpeechVoiceCache } from '@/lib/desktop/server/speech'
import { createDesktopAgent, createDesktopSession } from '@/lib/desktop/server/store'
import { GET, POST, PUT } from './route'
import { GET as VOICES } from './voices/route'

const originalEnv = { ...process.env }
const sessionToken = 'd'.repeat(48)
const origin = 'http://127.0.0.1:3101'
const KEY = 'synthetic-elevenlabs-key-for-tests'
const AUDIO = new Uint8Array([0xff, 0xfb, 0x90, 0x00, 1, 2, 3, 4])
let root: string
let server: Server
const transcripts = new Map<string, unknown[]>()
/** Every request this app made to ElevenLabs, and what the fake service answers next. */
const eleven: { url: string; method: string; key: string | null; body: unknown }[] = []
let elevenReply: () => Response | Promise<Response>
const realFetch = globalThis.fetch

beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'rerun-speech-'))
    transcripts.clear(); eleven.length = 0; clearDesktopSpeechVoiceCache()
    elevenReply = () => new Response(AUDIO, { headers: { 'content-type': 'audio/mpeg' } })
    server = createServer((req, res) => {
        const url = new URL(req.url ?? '/', 'http://engine')
        const json = (status: number, body: unknown) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body))
        const match = /^\/agents\/([^/]+)\/sessions\/([^/]+)\/messages$/.exec(url.pathname)
        if (req.method === 'GET' && match) return json(200, { messages: transcripts.get(`${decodeURIComponent(match[1])}/${decodeURIComponent(match[2])}`) ?? [] })
        json(404, { error: 'not found' })
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Missing test engine address')
    process.env.RERUN_DESKTOP_APP = '1'
    process.env.RERUN_DESKTOP_DATA_DIR = root
    process.env.RERUN_DESKTOP_RUNTIME_FILE = join(root, 'runtime.json')
    process.env.RERUN_DESKTOP_SECRET_KEY = 'ab'.repeat(32)
    await writeFile(join(root, 'runtime.json'), JSON.stringify({
        protocolVersion: 1, launchNonce: 'speech-launch', buildId: 'speech-build', workspaceId: 1, dataRoot: root,
        app: { origin, sessionToken },
        engine: { origin: `http://127.0.0.1:${address.port}`, apiKey: 'engine-secret' },
    }), { mode: 0o600 })
    // ElevenLabs is never reached: its address is answered here. The local test engine is real.
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input instanceof Request ? input.url : input)
        if (!url.startsWith('https://api.elevenlabs.io/')) return realFetch(input, init)
        const headers = new Headers(init?.headers)
        eleven.push({ url, method: init?.method ?? 'GET', key: headers.get('xi-api-key'), body: typeof init?.body === 'string' ? JSON.parse(init.body) : null })
        return elevenReply()
    }))
})

afterEach(async () => {
    vi.unstubAllGlobals()
    await closeDesktopDatabase(root)
    process.env = { ...originalEnv }
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    await rm(root, { recursive: true, force: true })
})

const headers = { host: '127.0.0.1:3101', origin, cookie: `rerun-desktop-session=${sessionToken}`, 'content-type': 'application/json' }
const saved = (id: string, sessionId: string, role: 'assistant' | 'user', text: string) => ({
    id, sessionId, role, contentJson: JSON.stringify([{ type: 'text', text }]), toolCallsJson: null, createdAt: '2026-01-01T00:00:00.000Z',
})
const speak = (body: unknown, override: Record<string, string> = {}) => POST(new Request(`${origin}/api/desktop/speech`, { method: 'POST', headers: { ...headers, ...override }, body: JSON.stringify(body) }))
const settings = () => GET(new Request(`${origin}/api/desktop/speech`, { headers }))
const change = (body: unknown) => PUT(new Request(`${origin}/api/desktop/speech`, { method: 'PUT', headers, body: JSON.stringify(body) }))
const voices = () => VOICES(new Request(`${origin}/api/desktop/speech/voices`, { headers }))
const refusal = (status: number, detail: Record<string, unknown>) => () => new Response(JSON.stringify({ detail }), { status, headers: { 'content-type': 'application/json' } })

async function workspace({ key = true } = {}) {
    const db = await openDesktopDatabase(root)
    const ada = await createDesktopAgent(db, { engineAgentId: 'engine-ada', name: 'Ada' })
    const bea = await createDesktopAgent(db, { engineAgentId: 'engine-bea', name: 'Bea' })
    const first = await createDesktopSession(db, { agentId: ada.id, engineSessionId: 'engine-session-1', title: 'First' })
    const other = await createDesktopSession(db, { agentId: bea.id, engineSessionId: 'engine-session-2', title: 'Other' })
    transcripts.set('engine-ada/engine-session-1', [
        saved('msg-q', 'engine-session-1', 'user', 'A question the person typed'),
        saved('msg-a', 'engine-session-1', 'assistant', '## Result\n\nIt is **done**. See [the notes](https://example.org/notes).\n\n```sh\nrm -rf build\n```\n\n| A | B |\n| - | - |\n| 1 | 2 |'),
        saved('msg-long', 'engine-session-1', 'assistant', 'word '.repeat(3_000)),
        saved('msg-blank', 'engine-session-1', 'assistant', '   '),
    ])
    transcripts.set('engine-bea/engine-session-2', [saved('msg-b', 'engine-session-2', 'assistant', 'Bea’s private answer')])
    if (key) await desktopAuxiliaryStore(db).change({ purpose: 'elevenlabs-transcription', expectedRevision: 'unconfigured', key: KEY })
    return { db, ada, bea, first, other }
}

describe('POST /api/desktop/speech', () => {
    it('refuses a request without the app session, from another origin, or from another site', async () => {
        const { ada, first } = await workspace()
        const body = { agentId: ada.id, sessionId: first.id, messageId: 'engine-msg-a' }
        expect((await speak(body, { cookie: 'rerun-desktop-session=wrong' })).status).toBe(401)
        expect((await speak(body, { origin: 'https://example.org' })).status).toBe(403)
        expect((await speak(body, { 'sec-fetch-site': 'cross-site' })).status).toBe(403)
        expect((await settings()).status).toBe(200)
        expect((await GET(new Request(`${origin}/api/desktop/speech`, { headers: { ...headers, cookie: '' } }))).status).toBe(401)
        expect((await VOICES(new Request(`${origin}/api/desktop/speech/voices`, { headers: { ...headers, cookie: '' } }))).status).toBe(401)
        expect(eleven).toEqual([])
    })

    it('speaks the saved reply as plain speech with the saved key and returns only audio', async () => {
        const { ada, first } = await workspace()
        const response = await speak({ agentId: ada.id, sessionId: first.id, messageId: 'engine-msg-a' })
        expect(response.status).toBe(200)
        expect(response.headers.get('content-type')).toBe('audio/mpeg')
        expect(response.headers.get('x-content-type-options')).toBe('nosniff')
        expect(response.headers.get('cache-control')).toBe('no-store')
        expect(response.headers.get('x-rerun-speech-truncated')).toBe('0')
        expect(new Uint8Array(await response.arrayBuffer())).toEqual(AUDIO)
        expect(eleven).toEqual([{
            url: `https://api.elevenlabs.io/v1/text-to-speech/${DESKTOP_SPEECH_DEFAULT_VOICE.id}/stream?output_format=mp3_44100_128`, method: 'POST', key: KEY,
            body: { text: 'Result\nIt is done. See the notes.\nCode block omitted.\nTable omitted.', model_id: 'eleven_multilingual_v2' },
        }])
        expect([...response.headers].flat().join(' ')).not.toContain(KEY)
    })

    it('never speaks text the renderer supplies', async () => {
        const { ada, first } = await workspace()
        expect((await speak({ agentId: ada.id, sessionId: first.id, messageId: 'engine-msg-a', text: 'Read my own words' })).status).toBe(400)
        expect((await speak({ preview: true, text: 'Read my own words' })).status).toBe(400)
        expect((await speak({ text: 'Read my own words' })).status).toBe(400)
        expect(eleven).toEqual([])
    })

    it('speaks only a reply saved in a conversation of the named coworker', async () => {
        const { ada, bea, first, other } = await workspace()
        // Another coworker's conversation, a reply from another conversation, the person's own message, an unknown reply.
        expect((await speak({ agentId: ada.id, sessionId: other.id, messageId: 'engine-msg-b' })).status).toBe(404)
        expect((await speak({ agentId: bea.id, sessionId: first.id, messageId: 'engine-msg-a' })).status).toBe(404)
        expect((await speak({ agentId: ada.id, sessionId: first.id, messageId: 'engine-msg-b' })).status).toBe(404)
        expect((await speak({ agentId: ada.id, sessionId: first.id, messageId: 'engine-msg-q' })).status).toBe(404)
        expect((await speak({ agentId: ada.id, sessionId: first.id, messageId: 'engine-missing' })).status).toBe(404)
        const empty = await speak({ agentId: ada.id, sessionId: first.id, messageId: 'engine-msg-blank' })
        expect(empty.status).toBe(422)
        expect(await empty.json()).toEqual({ code: 'speech_nothing', error: 'This reply has nothing to read aloud.' })
        expect(eleven).toEqual([])
    })

    it('sends at most the first 4,000 characters and says the reply was shortened', async () => {
        const { ada, first } = await workspace()
        const response = await speak({ agentId: ada.id, sessionId: first.id, messageId: 'engine-msg-long' })
        expect(response.status).toBe(200)
        expect(response.headers.get('x-rerun-speech-truncated')).toBe('1')
        const sent = (eleven[0].body as { text: string }).text
        expect(sent.length).toBeLessThanOrEqual(DESKTOP_SPEECH_MAX_CHARS)
        expect(response.headers.get('x-rerun-speech-characters')).toBe(String(sent.length))
    })

    it('says plainly when no key is saved, without calling ElevenLabs', async () => {
        const { ada, first } = await workspace({ key: false })
        const response = await speak({ agentId: ada.id, sessionId: first.id, messageId: 'engine-msg-a' })
        expect(response.status).toBe(409)
        expect(await response.json()).toEqual({ code: 'speech_no_key', error: 'Add an ElevenLabs key in Settings, under Tool services, to hear replies.' })
        expect(eleven).toEqual([])
    })

    it.each([
        ['a refused key', refusal(401, { type: 'authentication_error', code: 'invalid_api_key', message: 'Invalid API key' }), 'speech_key_refused', 'ElevenLabs refused the saved key. Check it in Settings, under Tool services.'],
        ['a key without permission', refusal(403, { type: 'authorization_error', code: 'insufficient_permissions', message: 'no' }), 'speech_key_refused', 'ElevenLabs refused the saved key. Check it in Settings, under Tool services.'],
        ['no credits left', refusal(402, { type: 'payment_required', code: 'insufficient_credits', message: 'You have 12 credits\nremaining, while 400 credits are required.' }), 'speech_quota', 'Your ElevenLabs account has no credits left for this. ElevenLabs says: You have 12 credits remaining, while 400 credits are required.'],
        ['the older quota answer', refusal(401, { status: 'quota_exceeded', message: 'This request exceeds your quota.' }), 'speech_quota', 'Your ElevenLabs account has no credits left for this. ElevenLabs says: This request exceeds your quota.'],
        ['a voice that is gone', refusal(404, { type: 'not_found', code: 'voice_not_found', message: 'gone' }), 'speech_voice_missing', 'ElevenLabs no longer has the chosen voice. Pick another in Settings, under Tool services.'],
        ['too many requests', refusal(429, { type: 'rate_limit_error', code: 'rate_limit_exceeded', message: 'slow down' }), 'speech_busy', 'ElevenLabs is busy right now. Try again in a moment.'],
        ['a broken service', () => new Response('<html>oops</html>', { status: 500 }), 'speech_failed', 'ElevenLabs could not read this aloud.'],
        ['a page instead of audio', () => new Response('<html>sign in</html>', { headers: { 'content-type': 'text/html' } }), 'speech_failed', 'ElevenLabs could not read this aloud.'],
        ['a service that cannot be reached', () => { throw new TypeError('fetch failed') }, 'speech_unreachable', 'ElevenLabs could not be reached. Check your connection and try again.'],
    ] as const)('gives a plain message for %s', async (_name, reply, code, message) => {
        const { ada, first } = await workspace()
        elevenReply = reply
        const response = await speak({ agentId: ada.id, sessionId: first.id, messageId: 'engine-msg-a' })
        expect(response.status).toBe(502)
        const text = await response.text()
        expect(JSON.parse(text)).toEqual({ code, error: message })
        expect(text).not.toContain(KEY)
    })

    it('speaks the fixed preview sentence in the chosen voice', async () => {
        await workspace()
        expect((await change({ voiceId: 'EXAVITQu4vr4xnSDxMaL' })).status).toBe(200)
        const response = await speak({ preview: true })
        expect(response.status).toBe(200)
        expect(eleven[0].url).toBe('https://api.elevenlabs.io/v1/text-to-speech/EXAVITQu4vr4xnSDxMaL/stream?output_format=mp3_44100_128')
        expect(eleven[0].body).toEqual({ text: DESKTOP_SPEECH_PREVIEW_SENTENCE, model_id: 'eleven_multilingual_v2' })
    })
})

describe('speech settings', () => {
    it('reports whether a key is saved, never the key, with automatic reading off by default', async () => {
        await workspace({ key: false })
        expect(await (await settings()).json()).toEqual({ configured: false, voiceId: DESKTOP_SPEECH_DEFAULT_VOICE.id, autoRead: false })
        const db = await openDesktopDatabase(root)
        await desktopAuxiliaryStore(db).change({ purpose: 'elevenlabs-transcription', expectedRevision: 'unconfigured', key: KEY })
        const text = await (await settings()).text()
        expect(JSON.parse(text)).toEqual({ configured: true, voiceId: DESKTOP_SPEECH_DEFAULT_VOICE.id, autoRead: false })
        expect(text).not.toContain(KEY)
    })

    it('saves the voice and the automatic switch separately and rejects anything else', async () => {
        await workspace()
        expect(await (await change({ autoRead: true })).json()).toEqual({ configured: true, voiceId: DESKTOP_SPEECH_DEFAULT_VOICE.id, autoRead: true })
        expect(await (await change({ voiceId: 'EXAVITQu4vr4xnSDxMaL' })).json()).toEqual({ configured: true, voiceId: 'EXAVITQu4vr4xnSDxMaL', autoRead: true })
        expect(await (await change({ voiceId: null, autoRead: false })).json()).toEqual({ configured: true, voiceId: DESKTOP_SPEECH_DEFAULT_VOICE.id, autoRead: false })
        expect((await change({ voiceId: '../v1/user' })).status).toBe(400)
        expect((await change({})).status).toBe(400)
        expect((await change({ autoRead: true, key: 'x' })).status).toBe(400)
    })

    it('lists the account’s voices with the saved key, once per key, and never returns the key', async () => {
        await workspace()
        elevenReply = () => Response.json({
            voices: [
                { voice_id: 'pNInz6obpgDQGcFmaJgB', name: 'Adam', category: 'premade', labels: { accent: 'american', gender: 'male' }, preview_url: 'https://example.org/a.mp3' },
                { voice_id: '21m00Tcm4TlvDq8ikWAM', name: ' Rachel ', category: 'premade', labels: null },
                { voice_id: '../../v1/user', name: 'Path trick' },
                { voice_id: 'pNInz6obpgDQGcFmaJgB', name: 'Adam again' },
                { voice_id: 'abcdefgh12345678', name: '' },
            ], has_more: false,
        })
        const first = await voices()
        const text = await first.text()
        expect(JSON.parse(text)).toEqual({ voices: [
            { id: 'pNInz6obpgDQGcFmaJgB', name: 'Adam', detail: 'american, male, premade' },
            { id: '21m00Tcm4TlvDq8ikWAM', name: 'Rachel', detail: 'premade' },
        ] })
        expect(text).not.toContain(KEY)
        expect(eleven).toEqual([{ url: 'https://api.elevenlabs.io/v2/voices?page_size=100&include_total_count=false', method: 'GET', key: KEY, body: null }])
        await voices()
        expect(eleven).toHaveLength(1)
    })

    it('gives the plain message when the voices cannot be listed', async () => {
        await workspace({ key: false })
        expect(await (await voices()).json()).toMatchObject({ code: 'speech_no_key' })
        const db = await openDesktopDatabase(root)
        await desktopAuxiliaryStore(db).change({ purpose: 'elevenlabs-transcription', expectedRevision: 'unconfigured', key: KEY })
        elevenReply = refusal(401, { code: 'invalid_api_key', message: 'Invalid API key' })
        expect(await (await voices()).json()).toMatchObject({ code: 'speech_key_refused' })
    })
})

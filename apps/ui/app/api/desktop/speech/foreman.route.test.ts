import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { DesktopHttpError } from '@/lib/desktop/server/auth'
import { desktopAuxiliaryStore } from '@/lib/desktop/server/auxiliary/store'
import { closeDesktopDatabase, openDesktopDatabase } from '@/lib/desktop/server/database'

const mock = vi.hoisted(() => ({ asked: [] as unknown[], state: null as unknown }))
vi.mock('@/lib/desktop/server/foreman/binding', () => ({
    desktopForeman: async () => ({
        state: async (chat: { workspaceId: string; chatId: string }) => {
            mock.asked.push(chat)
            if (chat.chatId === 'unknown') throw new DesktopHttpError(404, 'Conversation not found.')
            return mock.state
        },
    }),
}))
import { POST } from './route'

const originalEnv = { ...process.env }
const sessionToken = 'd'.repeat(48), origin = 'http://127.0.0.1:3101', KEY = 'synthetic-elevenlabs-key-for-tests'
const headers = { host: '127.0.0.1:3101', origin, cookie: `rerun-desktop-session=${sessionToken}`, 'content-type': 'application/json' }
const sent: { url: string; body: { text: string } }[] = []
let root: string

beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'rerun-speech-foreman-'))
    sent.length = 0; mock.asked.length = 0
    mock.state = {
        chat: { workspaceId: 'workspace-1', chatId: 'chat-1' },
        messages: [
            { id: 'engine-u1', role: 'user', parts: [{ type: 'text', text: 'What the person asked' }] },
            { id: 'engine-a1', role: 'assistant', parts: [{ type: 'text', text: 'First, **hire** Ada.' }, { type: 'tool-call_agent' }, { type: 'text', text: 'Then see [the plan](https://example.org/plan).' }] },
        ],
    }
    process.env.RERUN_DESKTOP_APP = '1'
    process.env.RERUN_DESKTOP_DATA_DIR = root
    process.env.RERUN_DESKTOP_RUNTIME_FILE = join(root, 'runtime.json')
    process.env.RERUN_DESKTOP_SECRET_KEY = 'ab'.repeat(32)
    await writeFile(join(root, 'runtime.json'), JSON.stringify({
        protocolVersion: 1, launchNonce: 'speech-launch', buildId: 'speech-build', workspaceId: 1, dataRoot: root,
        app: { origin, sessionToken }, engine: { origin: 'http://127.0.0.1:9', apiKey: 'engine-secret' },
    }), { mode: 0o600 })
    await desktopAuxiliaryStore(await openDesktopDatabase(root)).change({ purpose: 'elevenlabs-transcription', expectedRevision: 'unconfigured', key: KEY })
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        sent.push({ url: String(input), body: JSON.parse(String(init?.body)) })
        return new Response(new Uint8Array([1, 2]), { headers: { 'content-type': 'audio/mpeg' } })
    }))
})
afterEach(async () => {
    vi.unstubAllGlobals()
    await closeDesktopDatabase(root)
    process.env = { ...originalEnv }
    await rm(root, { recursive: true, force: true })
})
const speak = (body: unknown) => POST(new Request(`${origin}/api/desktop/speech`, { method: 'POST', headers, body: JSON.stringify(body) }))

it('speaks a saved Chief of Staff answer from the conversation this workspace owns', async () => {
    const response = await speak({ foreman: { workspaceId: 'workspace-1', chatId: 'chat-1' }, messageId: 'engine-a1' })
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('audio/mpeg')
    expect(mock.asked).toEqual([{ workspaceId: 'workspace-1', chatId: 'chat-1' }])
    expect(sent.map(call => call.body.text)).toEqual(['First, hire Ada.\nThen see the plan.'])
})

it('refuses another conversation, the person’s own message, an unknown answer, and text of the renderer’s own', async () => {
    expect((await speak({ foreman: { workspaceId: 'workspace-1', chatId: 'unknown' }, messageId: 'engine-a1' })).status).toBe(404)
    // The binding answered with a different conversation than the one named.
    expect((await speak({ foreman: { workspaceId: 'workspace-2', chatId: 'chat-1' }, messageId: 'engine-a1' })).status).toBe(404)
    expect((await speak({ foreman: { workspaceId: 'workspace-1', chatId: 'chat-1' }, messageId: 'engine-u1' })).status).toBe(404)
    expect((await speak({ foreman: { workspaceId: 'workspace-1', chatId: 'chat-1' }, messageId: 'engine-missing' })).status).toBe(404)
    expect((await speak({ foreman: { workspaceId: 'workspace-1', chatId: 'chat-1' }, messageId: 'engine-a1', text: 'Say this' })).status).toBe(400)
    expect(sent).toEqual([])
})

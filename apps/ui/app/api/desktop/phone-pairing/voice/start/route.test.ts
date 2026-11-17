import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DesktopHttpError } from '@/lib/desktop/server/auth'

const startConversation = vi.fn()
vi.mock('@/lib/desktop/server/voice-engine/binding', () => ({ desktopVoiceEngine: async () => ({ startConversation }) }))
const { POST } = await import('./route')

const originalEnv = { ...process.env }
const sessionToken = 'v'.repeat(48)
const origin = 'http://127.0.0.1:3100'
let root: string

beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'rerun-desktop-voice-start-'))
    process.env.RERUN_DESKTOP_APP = '1'
    process.env.RERUN_DESKTOP_DATA_DIR = root
    process.env.RERUN_DESKTOP_RUNTIME_FILE = join(root, 'runtime.json')
    await writeFile(join(root, 'runtime.json'), JSON.stringify({
        protocolVersion: 1, launchNonce: 'voice-launch', buildId: 'voice-build', workspaceId: 1, dataRoot: root,
        app: { origin, sessionToken }, engine: { origin: 'http://127.0.0.1:3101', apiKey: 'voice-engine-secret' },
    }), { mode: 0o600 })
    startConversation.mockReset()
})
afterEach(async () => {
    process.env = { ...originalEnv }
    await rm(root, { recursive: true, force: true })
})

const post = (body: unknown, cookie = sessionToken) => POST(new Request(`${origin}/api/desktop/phone-pairing/voice/start`, {
    method: 'POST', body: JSON.stringify(body),
    headers: { host: '127.0.0.1:3100', origin, cookie: `rerun-desktop-session=${cookie}`, 'content-type': 'application/json' },
}))

describe('a phone asking for a voice conversation, as the pairing service relays it', () => {
    it('returns the token, its conversation id and expiry, and nothing else', async () => {
        startConversation.mockResolvedValue({ conversationToken: 'webrtc-token', conversationId: 'conv_1', expiresAt: '2026-11-17T12:00:00.000Z', extra: 'never sent' })
        const response = await post({ chatId: 'fmc_conversation1' })
        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({ conversationToken: 'webrtc-token', conversationId: 'conv_1', expiresAt: '2026-11-17T12:00:00.000Z' })
        expect(startConversation).toHaveBeenCalledWith({ workspaceId: '1', chatId: 'fmc_conversation1' }, expect.any(AbortSignal))
        expect(response.headers.get('cache-control')).toBe('no-store')
    })

    it('does not exist while the feature is off, and is unavailable while the relay is down', async () => {
        startConversation.mockRejectedValueOnce(new DesktopHttpError(404, 'Not found'))
        expect((await post({ chatId: 'fmc_conversation1' })).status).toBe(404)
        startConversation.mockRejectedValueOnce(new DesktopHttpError(503, 'Voice conversations are not available right now.', 'voice_unavailable'))
        expect((await post({ chatId: 'fmc_conversation1' })).status).toBe(503)
    })

    it('takes only a Chief of Staff conversation id, and only from the app\'s own session', async () => {
        for (const body of [{}, { chatId: 'not-a-chat' }, { chatId: 'fmc_conversation1', workspaceId: '2' }]) expect((await post(body)).status).toBe(400)
        expect((await post({ chatId: 'fmc_conversation1' }, 'x'.repeat(48))).status).toBe(401)
        expect(startConversation).not.toHaveBeenCalled()
    })
})

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const status = { relayOrigin: 'https://voice.example.com', enabled: false, keySaved: true, engineReady: false, engineStale: false, relayConnected: false }
const service = {
    status: vi.fn(async () => status),
    saveRelay: vi.fn(async () => ({ status, deploy: { installId: 'i'.repeat(43), relaySecret: 's'.repeat(43), workerSecret: '{}' } })),
    rotate: vi.fn(), createEngine: vi.fn(async () => ({ status })), setEnabled: vi.fn(async () => ({ status })), forget: vi.fn(async () => ({ status })),
}
vi.mock('@/lib/desktop/server/voice-engine/binding', () => ({ desktopVoiceEngine: async () => service }))
const { GET, POST } = await import('./route')

const originalEnv = { ...process.env }
const sessionToken = 'w'.repeat(48)
const origin = 'http://127.0.0.1:3100'
let root: string

beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'rerun-desktop-voice-settings-'))
    process.env.RERUN_DESKTOP_APP = '1'
    process.env.RERUN_DESKTOP_DATA_DIR = root
    process.env.RERUN_DESKTOP_RUNTIME_FILE = join(root, 'runtime.json')
    await writeFile(join(root, 'runtime.json'), JSON.stringify({
        protocolVersion: 1, launchNonce: 'voice-launch', buildId: 'voice-build', workspaceId: 1, dataRoot: root,
        app: { origin, sessionToken }, engine: { origin: 'http://127.0.0.1:3101', apiKey: 'voice-engine-secret' },
    }), { mode: 0o600 })
})
afterEach(async () => {
    process.env = { ...originalEnv }
    await rm(root, { recursive: true, force: true })
})

const headers = { host: '127.0.0.1:3100', origin, cookie: `rerun-desktop-session=${sessionToken}`, 'content-type': 'application/json' }
const post = (body: unknown) => POST(new Request(`${origin}/api/desktop/voice-engine`, { method: 'POST', body: JSON.stringify(body), headers }))

describe('the phone voice settings route', () => {
    it('reads the status, and passes each action to the service', async () => {
        expect(await (await GET(new Request(`${origin}/api/desktop/voice-engine`, { headers }))).json()).toEqual({ status })
        expect((await (await post({ action: 'relay', relayOrigin: 'https://voice.example.com' })).json()).deploy.installId).toBe('i'.repeat(43))
        await post({ action: 'create-engine' })
        await post({ action: 'enabled', enabled: true })
        await post({ action: 'forget' })
        expect(service.saveRelay).toHaveBeenCalledWith('https://voice.example.com')
        expect(service.createEngine).toHaveBeenCalledTimes(1)
        expect(service.setEnabled).toHaveBeenCalledWith(true)
        expect(service.forget).toHaveBeenCalledTimes(1)
    })

    it('refuses what it does not understand, and a page from elsewhere', async () => {
        expect((await post({ action: 'relay' })).status).toBe(400)
        expect((await post({ action: 'secret' })).status).toBe(400)
        const foreign = await POST(new Request(`${origin}/api/desktop/voice-engine`, { method: 'POST', body: '{"action":"forget"}', headers: { ...headers, origin: 'https://evil.example' } }))
        expect(foreign.status).toBe(403)
    })
})

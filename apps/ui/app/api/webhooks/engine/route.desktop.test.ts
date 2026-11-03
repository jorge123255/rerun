import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { POST } from './route'

const legacy = vi.hoisted(() => ({ authenticate: vi.fn(), created: vi.fn(), follow: vi.fn(), notify: vi.fn() }))
vi.mock('@/app/api/_services/workspace-engine.service', () => ({ authenticateEngineToken: legacy.authenticate }))
vi.mock('@/app/api/_services/getting-started.service', () => ({ recordGettingStartedEvent: legacy.created }))
vi.mock('@/app/api/_services/notification-audience.service', () => ({ followAuthorOfCreatedTask: legacy.follow }))
vi.mock('@/app/api/_services/notification.service', () => ({ recordNotification: legacy.notify }))

const originalEnv = { ...process.env }
let root: string

beforeEach(async () => {
    vi.clearAllMocks()
    root = await mkdtemp(join(tmpdir(), 'rerun-desktop-callback-'))
    process.env.RERUN_DESKTOP_APP = '1'
    process.env.RERUN_DESKTOP_DATA_DIR = root
    process.env.RERUN_DESKTOP_RUNTIME_FILE = join(root, 'runtime.json')
    await writeFile(join(root, 'runtime.json'), JSON.stringify({
        protocolVersion: 1,
        launchNonce: 'callback-launch',
        buildId: 'callback-build',
        workspaceId: 1,
        dataRoot: root,
        app: { origin: 'http://127.0.0.1:3100', sessionToken: 'c'.repeat(48) },
        engine: { origin: 'http://127.0.0.1:3101', apiKey: 'engine-secret' },
    }), { mode: 0o600 })
})

afterEach(async () => {
    process.env = { ...originalEnv }
    await rm(root, { recursive: true, force: true })
})

function request(body: unknown, init: { authorization?: string; host?: string } = {}) {
    return new Request('http://127.0.0.1:3100/api/webhooks/engine', {
        method: 'POST',
        headers: {
            host: init.host ?? '127.0.0.1:3100',
            authorization: init.authorization ?? 'Bearer engine-secret',
            'content-type': 'application/json',
        },
        body: typeof body === 'string' ? body : JSON.stringify(body),
    })
}

function expectNoLegacyServices() {
    expect(legacy.authenticate).not.toHaveBeenCalled()
    expect(legacy.created).not.toHaveBeenCalled()
    expect(legacy.follow).not.toHaveBeenCalled()
    expect(legacy.notify).not.toHaveBeenCalled()
}

describe('desktop engine callback', () => {
    it.each([
        ['missing bearer', ''],
        ['wrong bearer', 'Bearer wrong'],
    ])('rejects %s with 401', async (_label, authorization) => {
        const response = await POST(request({ event: 'box.connection.connected' }, { authorization }))
        expect(response.status).toBe(401)
        expectNoLegacyServices()
    })

    it('rejects a wrong runtime Host with 403', async () => {
        const response = await POST(request({ event: 'box.connection.connected' }, { host: 'localhost:3100' }))
        expect(response.status).toBe(403)
        expectNoLegacyServices()
    })

    it.each([
        [{ event: 'box.connection.connected', kind: 'info', agentId: null, message: 'openai', metadata: null, title: null, source: null, originAgentId: null, timestamp: '2026-01-01T00:00:00.000Z' }],
        [{ event: 'agent.message.completed', kind: 'done', agentId: 'engine-agent-1', sessionId: 'engine-session-1', runId: 'run-1', message: 'Done', timestamp: '2026-01-01T00:00:00.000Z' }],
    ])('accepts a supported M1 event without Supabase', async body => {
        const response = await POST(request(body))
        expect(response.status).toBe(202)
        expect(await response.json()).toEqual({ ok: true, persisted: false })
        expectNoLegacyServices()
    })

    it('acknowledges a deferred valid event as ignored rather than claiming notification storage', async () => {
        const response = await POST(request({ event: 'agent.schedule.created', agentId: 'engine-agent-1' }))
        expect(response.status).toBe(202)
        expect(await response.json()).toEqual({ ok: true, ignored: 'unsupported_m1_event', persisted: false })
        expectNoLegacyServices()
    })

    it('rejects an invalid payload with 400', async () => {
        const response = await POST(request({ event: 'agent.message.completed', kind: 'done' }))
        expect(response.status).toBe(400)
        expectNoLegacyServices()
    })
})

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { closeDesktopDatabase } from '@/lib/desktop/server/database'
import { GET } from './route'

const originalEnv = { ...process.env }
const sessionToken = 'h'.repeat(48)
let root: string

beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'rerun-desktop-health-'))
    process.env.RERUN_DESKTOP_APP = '1'
    process.env.RERUN_DESKTOP_DATA_DIR = root
    process.env.RERUN_DESKTOP_RUNTIME_FILE = join(root, 'runtime.json')
    await writeFile(join(root, 'runtime.json'), JSON.stringify({
        protocolVersion: 1,
        launchNonce: 'health-launch',
        buildId: 'health-build',
        workspaceId: 1,
        dataRoot: root,
        app: { origin: 'http://127.0.0.1:3100', sessionToken },
        engine: { origin: 'http://127.0.0.1:3101', apiKey: 'health-engine-secret' },
    }), { mode: 0o600 })
})

afterEach(async () => {
    await closeDesktopDatabase(root)
    process.env = { ...originalEnv }
    await rm(root, { recursive: true, force: true })
})

function request(cookie = sessionToken) {
    return new Request('http://127.0.0.1:3100/api/desktop/health', {
        headers: { host: '127.0.0.1:3100', cookie: `rerun-desktop-session=${cookie}` },
    })
}

describe('desktop health', () => {
    it('reports ready only after initializing the app database and never returns secrets', async () => {
        const response = await GET(request())
        expect(response.status).toBe(200)
        const body = await response.json()
        expect(body).toEqual({ protocolVersion: 1, launchNonce: 'health-launch', buildId: 'health-build', workspaceId: 1, status: 'ready' })
        expect(JSON.stringify(body)).not.toContain(sessionToken)
        expect(JSON.stringify(body)).not.toContain('health-engine-secret')
    })

    it('rejects an invalid session without initializing readiness', async () => {
        const response = await GET(request('wrong'))
        expect(response.status).toBe(401)
        expect(await response.json()).toEqual({ error: 'Unauthorized' })
    })
})

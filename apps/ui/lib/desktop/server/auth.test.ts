import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { authenticateDesktopRequest, DESKTOP_SESSION_COOKIE } from './auth'

const originalEnv = { ...process.env }
const token = 's'.repeat(48)
let root: string

beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'rerun-desktop-auth-'))
    process.env.RERUN_DESKTOP_APP = '1'
    process.env.RERUN_DESKTOP_DATA_DIR = root
    process.env.RERUN_DESKTOP_RUNTIME_FILE = join(root, 'runtime.json')
    await writeFile(join(root, 'runtime.json'), JSON.stringify({
        protocolVersion: 1,
        launchNonce: 'launch-test',
        buildId: 'build-test',
        workspaceId: 1,
        dataRoot: root,
        app: { origin: 'http://127.0.0.1:3100', sessionToken: token },
        engine: { origin: 'http://127.0.0.1:3101', apiKey: 'engine-test-key' },
    }), { mode: 0o600 })
})

afterEach(async () => {
    process.env = { ...originalEnv }
    await rm(root, { recursive: true, force: true })
})

function request(init: { method?: string; cookie?: string | null; host?: string; origin?: string; fetchSite?: string } = {}) {
    const headers = new Headers({ host: init.host ?? '127.0.0.1:3100' })
    if (init.cookie !== null) headers.set('cookie', `${DESKTOP_SESSION_COOKIE}=${init.cookie ?? token}`)
    if (init.origin) headers.set('origin', init.origin)
    if (init.fetchSite) headers.set('sec-fetch-site', init.fetchSite)
    return new Request('http://127.0.0.1:3100/api/desktop/health', { method: init.method ?? 'GET', headers })
}

describe('authenticateDesktopRequest', () => {
    it('accepts the provisioned HttpOnly session cookie and loopback host', async () => {
        const runtime = await authenticateDesktopRequest(request())
        expect(runtime.workspaceId).toBe(1)
        expect(runtime.launchNonce).toBe('launch-test')
    })

    it('rejects a missing or incorrect session cookie', async () => {
        await expect(authenticateDesktopRequest(request({ cookie: null }))).rejects.toMatchObject({ status: 401 })
        await expect(authenticateDesktopRequest(request({ cookie: 'wrong' }))).rejects.toMatchObject({ status: 401 })
    })

    it('rejects a host that differs from the runtime application origin', async () => {
        await expect(authenticateDesktopRequest(request({ host: 'localhost:3100' }))).rejects.toMatchObject({ status: 403 })
    })

    it('requires the application origin on mutations', async () => {
        await expect(authenticateDesktopRequest(request({ method: 'POST' }))).rejects.toMatchObject({ status: 403 })
        await expect(authenticateDesktopRequest(request({ method: 'POST', origin: 'https://evil.example' }))).rejects.toMatchObject({ status: 403 })
        await expect(authenticateDesktopRequest(request({ method: 'POST', origin: 'http://127.0.0.1:3100' }))).resolves.toMatchObject({ workspaceId: 1 })
    })

    it('rejects cross-site browser requests even with a valid cookie', async () => {
        await expect(authenticateDesktopRequest(request({ fetchSite: 'cross-site' }))).rejects.toMatchObject({ status: 403 })
    })
})

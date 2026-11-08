import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { fxBoardCameraHandlers } from '../fx-repairs/board-camera-store'
import { authenticateDesktopRequest, DESKTOP_SESSION_COOKIE } from './auth'
import { closeDesktopDatabase } from './database'
import { beginDesktopWorkspaceAdmission } from './workspace-admission'

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
    await closeDesktopDatabase(root)
    process.env = { ...originalEnv }
    await rm(root, { recursive: true, force: true })
})

function request(init: { method?: string; cookie?: string | null; host?: string; origin?: string; fetchSite?: string; path?: string; body?: unknown } = {}) {
    const headers = new Headers({ host: init.host ?? '127.0.0.1:3100' })
    if (init.cookie !== null) headers.set('cookie', `${DESKTOP_SESSION_COOKIE}=${init.cookie ?? token}`)
    if (init.origin) headers.set('origin', init.origin)
    if (init.fetchSite) headers.set('sec-fetch-site', init.fetchSite)
    if (init.body !== undefined) headers.set('content-type', 'application/json')
    return new Request('http://127.0.0.1:3100' + (init.path ?? '/api/desktop/health'), {
        method: init.method ?? 'GET', headers, body: init.body === undefined ? undefined : JSON.stringify(init.body),
    })
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

    it('persists an already pending board view while workspace switching freezes new writes', async () => {
        const runtime = await authenticateDesktopRequest(request())
        const path = '/api/desktop/workspaces/1/board-camera'
        const camera = { pan: { x: 24, y: -18 }, zoom: 1.25 }
        const requestId = '00000000-0000-4000-8000-000000000001'
        const pending = request({
            path, method: 'PUT', origin: runtime.app.origin,
            body: { workspaceId: 1, expectedRevision: 0, requestId, camera },
        })
        beginDesktopWorkspaceAdmission(runtime, 'freeze', 1)
        const saved = await fxBoardCameraHandlers.write(pending, '1')
        expect(saved.status).toBe(200)
        const snapshot = { workspaceId: 1, revision: 1, camera }
        expect(await saved.json()).toEqual({ status: 'saved', requestId, snapshot })
        await closeDesktopDatabase(root)
        expect(await (await fxBoardCameraHandlers.read(request({ path }), '1')).json()).toEqual(snapshot)
    })

    it('keeps the freeze and browser authentication for every other write', async () => {
        const runtime = await authenticateDesktopRequest(request())
        const path = '/api/desktop/workspaces/1/board-camera'
        const origin = runtime.app.origin
        beginDesktopWorkspaceAdmission(runtime, 'freeze', 1)
        await expect(authenticateDesktopRequest(request({ method: 'POST', path: '/api/desktop/chat', origin }))).rejects.toMatchObject({ status: 409 })
        await expect(authenticateDesktopRequest(request({ method: 'PUT', path: '/api/desktop/workspaces/2/board-camera', origin }))).rejects.toMatchObject({ status: 409 })
        await expect(authenticateDesktopRequest(request({ method: 'POST', path, origin }))).rejects.toMatchObject({ status: 409 })
        await expect(authenticateDesktopRequest(request({ method: 'PUT', path, origin, cookie: null }))).rejects.toMatchObject({ status: 401 })
        await expect(authenticateDesktopRequest(request({ method: 'PUT', path, origin: 'https://other.example' }))).rejects.toMatchObject({ status: 403 })
    })

    it('rejects cross-site browser requests even with a valid cookie', async () => {
        await expect(authenticateDesktopRequest(request({ fetchSite: 'cross-site' }))).rejects.toMatchObject({ status: 403 })
    })
})

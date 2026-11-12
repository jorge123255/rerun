import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { GET, PUT } from './route'
import { DELETE as removePhoto, GET as getPhoto, PUT as putPhoto } from './photo/route'
import { closeDesktopDatabase } from '@/lib/desktop/server/database'
import { DESKTOP_IMAGE_MAX_BYTES } from '@/lib/desktop/server/image-bytes'
import type { DesktopRuntime } from '@/lib/desktop/server/runtime'
import { onePixelPng } from '@/lib/desktop/server/shared-file-previews/test-helpers'
import { setDesktopWorkspaceFrozen } from '@/lib/desktop/server/workspace-admission'

test('profile writes are authenticated and persist across workspaces and database reopen', async () => {
    const installRoot = await mkdtemp(join(await realpath(tmpdir()), 'rerun-profile-'))
    const runtimeFile = join(installRoot, 'runtime.json')
    const installId = randomUUID()
    const otherDataRoot = join(installRoot, 'workspaces', '2')
    const engineRoot = join(otherDataRoot, 'engine')
    const app = { origin: 'http://127.0.0.1:3100', sessionToken: 'a'.repeat(40) }
    const first: DesktopRuntime = { protocolVersion: 1, workspaceId: 1, launchNonce: 'profile-test-first',
        buildId: 'profile-test', dataRoot: installRoot, installRoot, installId, app,
        engine: { origin: 'http://127.0.0.1:1', apiKey: 'local-fixture' } }
    const second: DesktopRuntime = { ...first, workspaceId: 2, launchNonce: 'profile-test-second', dataRoot: otherDataRoot, engineRoot }
    const env = { ...process.env }
    async function activate(runtime: DesktopRuntime) {
        await writeFile(runtimeFile, JSON.stringify(runtime), { mode: 0o600 })
        process.env.RERUN_DESKTOP_APP = '1'
        process.env.RERUN_DESKTOP_DATA_DIR = runtime.dataRoot
        process.env.RERUN_DESKTOP_INSTALL_DIR = installRoot
        process.env.RERUN_DESKTOP_WORKSPACE_ID = String(runtime.workspaceId)
        process.env.RERUN_DESKTOP_RUNTIME_FILE = runtimeFile
    }
    function request(path = '', init?: RequestInit) {
        return new Request(app.origin + '/api/desktop/profile' + path, { ...init, headers: {
            host: '127.0.0.1:3100', origin: app.origin, cookie: 'rerun-desktop-session=' + app.sessionToken,
            ...init?.headers,
        } })
    }
    const name = (body: unknown, headers?: Record<string, string>) => request('', { method: 'PUT',
        headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) })
    const png = Uint8Array.from(onePixelPng())
    const upload = (mime = 'image/png', headers?: Record<string, string>) => request('/photo', {
        method: 'PUT', headers: { 'content-type': mime, ...headers }, body: png,
    })
    try {
        await mkdir(engineRoot, { recursive: true })
        await writeFile(join(engineRoot, 'desktop-owner.json'), JSON.stringify({ installId, workspaceId: 2 }))
        await activate(first)
        expect(await (await GET(request())).json()).toEqual({ id: 1, displayName: 'Local User', photoId: null })
        expect((await PUT(name({ name: 'Unauthenticated' }, { cookie: 'rerun-desktop-session=wrong' }))).status).toBe(401)
        expect((await PUT(name({ name: 'Other origin' }, { origin: 'https://other.invalid' }))).status).toBe(403)
        for (const body of [{ name: ' ' }, { name: 'A\nB' }, { name: 'A'.repeat(81) }, { name: 'Ada', grant: true }]) {
            expect((await PUT(name(body))).status).toBe(400)
        }
        expect(await (await PUT(name({ name: '  Élodie Park  ' }))).json()).toEqual({ id: 1, displayName: 'Élodie Park', photoId: null })
        expect((await putPhoto(request('/photo', { method: 'PUT', headers: { 'content-type': 'image/png' },
            body: new Uint8Array(DESKTOP_IMAGE_MAX_BYTES + 1) }))).status).toBe(413)
        const photo = await putPhoto(upload())
        expect(photo.status).toBe(200)
        const saved = await photo.json()
        const photoPath = '/photo?id=' + saved.photoId
        expect((await getPhoto(request(photoPath, { headers: { cookie: '' } }))).status).toBe(401)
        const raster = await getPhoto(request(photoPath))
        expect(raster.status).toBe(200)
        expect(raster.headers.get('content-type')).toBe('image/webp')
        expect(raster.headers.get('x-content-type-options')).toBe('nosniff')
        const bytes = Buffer.from(await raster.arrayBuffer())
        expect(bytes.toString('ascii', 8, 12)).toBe('WEBP')
        expect((await putPhoto(upload('image/jpeg'))).status).toBe(415)

        await closeDesktopDatabase(installRoot)
        await activate(second)
        expect(await (await GET(request())).json()).toEqual(saved)
        expect(Buffer.from(await (await getPhoto(request(photoPath))).arrayBuffer())).toEqual(bytes)
        setDesktopWorkspaceFrozen(second, true)
        expect((await PUT(name({ name: 'Frozen' }))).status).toBe(409)
        expect((await removePhoto(request('/photo', { method: 'DELETE' }))).status).toBe(409)
        setDesktopWorkspaceFrozen(second, false)
        const replacement = await (await putPhoto(upload())).json()
        expect(replacement.photoId).not.toBe(saved.photoId)
        expect((await getPhoto(request(photoPath))).status).toBe(404)
        expect(await (await removePhoto(request('/photo', { method: 'DELETE' }))).json())
            .toEqual({ id: 1, displayName: 'Élodie Park', photoId: null })
        expect((await getPhoto(request('/photo?id=' + replacement.photoId))).status).toBe(404)
        await activate(first)
        expect(await (await GET(request())).json()).toEqual({ id: 1, displayName: 'Élodie Park', photoId: null })
    } finally {
        setDesktopWorkspaceFrozen(second, false)
        await closeDesktopDatabase(installRoot)
        process.env = env
        await rm(installRoot, { recursive: true, force: true })
    }
})

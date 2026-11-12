import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, symlink, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDesktopFileSaves, createDesktopResultFileSave, safeDisplayedImageError } from '../src/main/result-files.mjs'

test('native Save preserves ordinary names and writes only after confirmed destination', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rerun-save-result-'))
    try {
        const destination = join(root, "Bob's report;final.zip"), runtime = {}, window = {}
        let cancelled = true
        const save = createDesktopResultFileSave({ context: () => ({ runtime, window }), dialog: { showSaveDialog: async (_window, options) => {
            assert.equal(options.defaultPath, "Bob's report;final.zip")
            return { canceled: cancelled, filePath: destination }
        } } })
        const input = { name: "Bob's report;final.zip", bytes: new Uint8Array([1, 2, 3]) }
        assert.equal(await save(input), false)
        cancelled = false
        assert.equal(await save(input), true)
        assert.deepEqual(new Uint8Array(await readFile(destination)), input.bytes)
        await symlink(destination, join(root, 'linked.zip'))
        const linked = createDesktopResultFileSave({ context: () => ({ runtime, window }), dialog: { showSaveDialog: async () => ({ canceled: false, filePath: join(root, 'linked.zip') }) } })
        await assert.rejects(linked(input), /regular file/)
        await assert.rejects(save({ ...input, name: '../escape.zip' }), /supported/)
    } finally { await rm(root, { recursive: true, force: true }) }
})
test('a workspace change during the dialog does not write', async () => {
    let runtime = {}, window = {}
    const save = createDesktopResultFileSave({ context: () => ({ runtime, window }), dialog: { showSaveDialog: async () => {
        runtime = {}; return { canceled: false, filePath: '/must-not-write-result' }
    } } })
    await assert.rejects(save({ name: 'file.zip', bytes: new Uint8Array([1]) }), /workspace changed/)
})

const coworkerFile = { agentId: 'agent-alice', path: 'nested/recording.mp4', version: 'c'.repeat(64) }
const loopback = { app: { origin: 'http://127.0.0.1:3100', sessionToken: 'disposable-test-session' } }
const originalResponse = (bytes, length = bytes.byteLength) => new Response(bytes, {
    headers: { 'content-type': 'application/octet-stream', 'content-length': String(length) },
})

test('Coworker Save As fetches the exact version only after confirmation, including files over the chat result limit', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rerun-save-coworker-'))
    try {
        const filePath = join(root, 'recording.mp4')
        const bytes = Buffer.alloc(16 * 1024 * 1024 + 1, 0x3a)
        const window = {}
        let canceled = true
        let fetched = 0
        const { saveCoworkerFile } = createDesktopFileSaves({
            context: () => ({ runtime: loopback, window }),
            dialog: { showSaveDialog: async (_window, options) => {
                assert.equal(options.defaultPath, 'recording.mp4')
                return { canceled, filePath }
            } },
            fetchFile: async (url, options) => {
                fetched++
                assert.equal(url.origin, loopback.app.origin)
                assert.equal(url.pathname, '/api/desktop/agents/agent-alice/files/download')
                assert.deepEqual(Object.fromEntries(url.searchParams), { path: coworkerFile.path, version: coworkerFile.version })
                assert.equal(options.headers.Cookie, 'rerun-desktop-session=disposable-test-session')
                assert.equal(options.redirect, 'error')
                return originalResponse(bytes)
            },
        })
        assert.equal(await saveCoworkerFile(coworkerFile), false)
        assert.equal(fetched, 0)
        await assert.rejects(readFile(filePath), { code: 'ENOENT' })
        canceled = false
        assert.equal(await saveCoworkerFile(coworkerFile), true)
        assert.equal(fetched, 1)
        assert.deepEqual(await readFile(filePath), bytes)
    } finally { await rm(root, { recursive: true, force: true }) }
})

test('failed, incomplete and superseded coworker downloads leave the existing destination unchanged', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rerun-save-coworker-'))
    try {
        const filePath = join(root, 'recording.mp4')
        await writeFile(filePath, 'existing')
        const window = {}
        let runtime = loopback
        let reply = () => new Response(null, { status: 409 })
        const { saveCoworkerFile } = createDesktopFileSaves({
            context: () => ({ runtime, window }),
            dialog: { showSaveDialog: async () => ({ canceled: false, filePath }) },
            fetchFile: async () => reply(),
        })
        await assert.rejects(saveCoworkerFile(coworkerFile), /file changed/)
        reply = () => originalResponse(Uint8Array.of(1), 2)
        await assert.rejects(saveCoworkerFile(coworkerFile), /file’s length/)
        reply = () => {
            runtime = { ...loopback }
            return originalResponse(Uint8Array.of(1))
        }
        await assert.rejects(saveCoworkerFile(coworkerFile), /workspace changed/)
        assert.equal(await readFile(filePath, 'utf8'), 'existing')
    } finally { await rm(root, { recursive: true, force: true }) }
})

test('Shared Files Save As binds workspace, listed version and preview identity after the picker', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rerun-save-shared-'))
    try {
        const filePath = join(root, 'recording.mp4'), window = {}
        const runtime = { ...loopback, workspaceId: 7 }
        const selected = { workspaceId: 7, path: 'nested/recording.mp4', version: 'd'.repeat(64), identity: 'e'.repeat(64) }
        const bytes = Uint8Array.of(3, 4, 5)
        let canceled = true
        let dialogs = 0
        let requests = 0
        let version = selected.version
        const { saveSharedFile } = createDesktopFileSaves({
            context: () => ({ runtime, window }),
            dialog: { showSaveDialog: async (_window, options) => {
                dialogs++
                assert.equal(options.defaultPath, 'recording.mp4')
                return { canceled, filePath }
            } },
            fetchFile: async (url, options) => {
                requests++
                assert.equal(url.origin, loopback.app.origin)
                assert.equal(url.pathname, '/api/desktop/shared-files/download')
                assert.deepEqual(Object.fromEntries(url.searchParams), { ...selected, workspaceId: '7' })
                assert.equal(options.headers.Cookie, 'rerun-desktop-session=disposable-test-session')
                assert.equal(options.redirect, 'error')
                const response = originalResponse(bytes)
                response.headers.set('x-rerun-shared-version', version)
                response.headers.set('x-rerun-shared-sha256', selected.identity)
                return response
            },
        })
        await assert.rejects(saveSharedFile({ ...selected, workspaceId: 8 }), /workspace changed/)
        await assert.rejects(saveSharedFile({ ...selected, path: '../private.txt' }), /Shared Files/)
        assert.equal(dialogs, 0)
        assert.equal(await saveSharedFile(selected), false)
        assert.equal(requests, 0)
        await assert.rejects(readFile(filePath), { code: 'ENOENT' })
        canceled = false
        version = 'f'.repeat(64)
        await assert.rejects(saveSharedFile(selected), /Could not read this shared file/)
        await assert.rejects(readFile(filePath), { code: 'ENOENT' })
        version = selected.version
        assert.equal(await saveSharedFile(selected), true)
        assert.deepEqual(new Uint8Array(await readFile(filePath)), bytes)
    } finally { await rm(root, { recursive: true, force: true }) }
})

test('Shared Files Save As leaves an existing destination untouched if the workspace changes during the picker', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rerun-save-shared-'))
    try {
        const filePath = join(root, 'report.txt')
        await writeFile(filePath, 'existing')
        const window = {}
        let runtime = { ...loopback, workspaceId: 7 }
        const { saveSharedFile } = createDesktopFileSaves({
            context: () => ({ runtime, window }),
            dialog: { showSaveDialog: async () => {
                runtime = { ...runtime, workspaceId: 8 }
                return { canceled: false, filePath }
            } },
            fetchFile: () => assert.fail('a stale picker cannot fetch'),
        })
        await assert.rejects(saveSharedFile({ workspaceId: 7, path: 'report.txt', version: 'd'.repeat(64) }), /workspace changed/)
        assert.equal(await readFile(filePath, 'utf8'), 'existing')
    } finally { await rm(root, { recursive: true, force: true }) }
})

const imagePage = 'http://127.0.0.1:3100/desktop'
const imageVersion = 'c'.repeat(64)
const pngBytes = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4)
const boardImage = 'http://127.0.0.1:3100/api/desktop/agents/local-owner/files/image?path=reports%2Fchart+one.png&animation=1&workspaceOwner=engine-owner'
const imageRuntime = () => ({ ...loopback, workspaceId: 7 })

function jsonResponse(value, status = 200) {
    const body = Buffer.from(JSON.stringify(value))
    return new Response(body, { status, headers: { 'content-type': 'application/json', 'content-length': String(body.byteLength) } })
}

test('Save Image writes the version-checked original bytes and does not refetch the preview URL', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rerun-save-image-'))
    try {
        const filePath = join(root, 'chart one.png')
        const window = {}
        let canceled = true
        const requests = []
        const { saveDisplayedImage } = createDesktopFileSaves({
            context: () => ({ runtime: imageRuntime(), window }),
            dialog: { showSaveDialog: async (_window, options) => {
                assert.equal(options.title, 'Save Image')
                assert.equal(options.defaultPath, 'chart one.png')
                return { canceled, filePath }
            } },
            fetchFile: async (url, options) => {
                requests.push(url)
                assert.equal(options.headers.Cookie, 'rerun-desktop-session=disposable-test-session')
                assert.equal(options.redirect, 'error')
                assert.equal(options.cache, 'no-store')
                if (requests.length === 1) {
                    assert.equal(url.pathname, '/api/desktop/agents/local-owner/files')
                    assert.equal(url.searchParams.get('path'), 'reports')
                    return jsonResponse({ path: 'reports', entries: [{ name: 'chart one.png', type: 'file', exportVersion: imageVersion, identity: '4:8' }] })
                }
                assert.equal(url.pathname, '/api/desktop/agents/local-owner/files/download')
                assert.deepEqual(Object.fromEntries(url.searchParams), { path: 'reports/chart one.png', version: imageVersion })
                return originalResponse(pngBytes)
            },
        })
        assert.equal(await saveDisplayedImage(imagePage, boardImage), false)
        assert.equal(requests.length, 0)
        await assert.rejects(readFile(filePath), { code: 'ENOENT' })
        canceled = false
        assert.equal(await saveDisplayedImage(imagePage, boardImage), true)
        assert.equal(requests.length, 2)
        assert.equal(requests.some(url => url.pathname.endsWith('/image')), false)
        assert.deepEqual(new Uint8Array(await readFile(filePath)), pngBytes)
    } finally { await rm(root, { recursive: true, force: true }) }
})

test('Save Image uses the listed export version for a thumbnail, not its revision query', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rerun-save-image-'))
    try {
        const filePath = join(root, 'photo.jpg')
        const jpeg = Uint8Array.of(0xff, 0xd8, 0xff, 0xe0, 1, 2)
        const src = 'http://127.0.0.1:3100/api/desktop/agents/alice/files/image?path=photo.jpg&identity=12%3A34&revision=2026-01-02T03%3A04%3A05.000Z'
        const { saveDisplayedImage } = createDesktopFileSaves({
            context: () => ({ runtime: imageRuntime(), window: {} }),
            dialog: { showSaveDialog: async () => ({ canceled: false, filePath }) },
            fetchFile: async url => {
                if (url.pathname.endsWith('/files')) {
                    assert.equal(url.searchParams.get('path'), '')
                    return jsonResponse({ path: '', entries: [{ name: 'photo.jpg', type: 'file', exportVersion: imageVersion, identity: '12:34' }] })
                }
                assert.deepEqual(Object.fromEntries(url.searchParams), { path: 'photo.jpg', version: imageVersion })
                return originalResponse(jpeg)
            },
        })
        assert.equal(await saveDisplayedImage(imagePage, src), true)
        assert.deepEqual(new Uint8Array(await readFile(filePath)), jpeg)
    } finally { await rm(root, { recursive: true, force: true }) }
})

test('Save Image refuses a changed thumbnail identity, a mismatched format, and a failed download without writing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rerun-save-image-'))
    try {
        const filePath = join(root, 'photo.png')
        await writeFile(filePath, 'existing')
        const src = 'http://127.0.0.1:3100/api/desktop/agents/alice/files/image?path=photo.png&identity=12%3A34'
        let listing = { path: '', entries: [{ name: 'photo.png', type: 'file', exportVersion: imageVersion, identity: '9:9' }] }
        let download = () => originalResponse(Uint8Array.of(0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1))
        let downloads = 0
        const { saveDisplayedImage } = createDesktopFileSaves({
            context: () => ({ runtime: imageRuntime(), window: {} }),
            dialog: { showSaveDialog: async () => ({ canceled: false, filePath }) },
            fetchFile: async url => {
                if (url.pathname.endsWith('/download')) { downloads++; return download() }
                return jsonResponse(listing)
            },
        })
        await assert.rejects(saveDisplayedImage(imagePage, src), /image changed/)
        assert.equal(downloads, 0)
        listing = { path: '', entries: [{ name: 'photo.png', type: 'file', identity: '12:34' }] }
        await assert.rejects(saveDisplayedImage(imagePage, src), /can’t be saved/)
        assert.equal(downloads, 0)
        listing = { path: '', entries: [{ name: 'photo.png', type: 'file', exportVersion: imageVersion, identity: '12:34' }] }
        await assert.rejects(saveDisplayedImage(imagePage, src), /can’t be saved/)
        assert.equal(downloads, 1)
        download = () => new Response(null, { status: 409 })
        await assert.rejects(saveDisplayedImage(imagePage, src), /file changed/)
        assert.equal(await readFile(filePath, 'utf8'), 'existing')
        const dialogs = []
        const refused = createDesktopFileSaves({
            context: () => ({ runtime: imageRuntime(), window: {} }),
            dialog: { showSaveDialog: async () => { dialogs.push(true); return { canceled: true } } },
            fetchFile: () => assert.fail('an unsavable image cannot be read'),
        }).saveDisplayedImage
        await assert.rejects(refused(imagePage, 'http://127.0.0.1:3100/api/desktop/agents/alice/files/image?path=diagram.svg'), /shown on this board/)
        await assert.rejects(refused('http://127.0.0.1:3100/other', src), /workspace changed/)
        await assert.rejects(refused(imagePage, 'https://example.test/chart.png'), /shown on this board/)
        assert.equal(dialogs.length, 0)
        assert.equal(safeDisplayedImageError(new Error('ENOENT: /Users/secret/photo.png')), 'This image could not be saved.')
        assert.equal(safeDisplayedImageError(new Error('The workspace changed. Open the file again.')), 'The workspace changed. Open the file again.')
    } finally { await rm(root, { recursive: true, force: true }) }
})

test('Save Image leaves an existing file untouched when the workspace changes during the picker', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rerun-save-image-'))
    try {
        const filePath = join(root, 'team.png')
        await writeFile(filePath, 'existing')
        let runtime = imageRuntime()
        const { saveDisplayedImage } = createDesktopFileSaves({
            context: () => ({ runtime, window: {} }),
            dialog: { showSaveDialog: async () => { runtime = imageRuntime(); return { canceled: false, filePath } } },
            fetchFile: () => assert.fail('a stale picker cannot fetch'),
        })
        await assert.rejects(saveDisplayedImage(imagePage, 'http://127.0.0.1:3100/api/desktop/shared-files/media?path=team.png'), /workspace changed/)
        assert.equal(await readFile(filePath, 'utf8'), 'existing')
    } finally { await rm(root, { recursive: true, force: true }) }
})

test('Shared Save Image binds the current workspace version after the picker confirms', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rerun-save-image-'))
    try {
        const filePath = join(root, 'team.png')
        let canceled = true
        let requests = 0
        const { saveDisplayedImage } = createDesktopFileSaves({
            context: () => ({ runtime: imageRuntime(), window: {} }),
            dialog: { showSaveDialog: async (_window, options) => {
                assert.equal(options.defaultPath, 'team.png')
                return { canceled, filePath }
            } },
            fetchFile: async (url, options) => {
                requests++
                if (url.pathname === '/api/desktop/shared-files') {
                    assert.equal(url.searchParams.get('path'), 'reports')
                    return jsonResponse({ path: 'reports', entries: [{ name: 'team.png', type: 'file', deleteRevision: imageVersion }] })
                }
                assert.equal(url.pathname, '/api/desktop/shared-files/download')
                assert.deepEqual(Object.fromEntries(url.searchParams), { workspaceId: '7', path: 'reports/team.png', version: imageVersion })
                assert.equal(options.headers['x-rerun-shared-version'], undefined)
                const response = originalResponse(pngBytes)
                response.headers.set('x-rerun-shared-version', imageVersion)
                return response
            },
        })
        assert.equal(await saveDisplayedImage(imagePage, 'http://127.0.0.1:3100/api/desktop/shared-files/media?path=reports%2Fteam.png'), false)
        assert.equal(requests, 0)
        await assert.rejects(readFile(filePath), { code: 'ENOENT' })
        canceled = false
        assert.equal(await saveDisplayedImage(imagePage, 'http://127.0.0.1:3100/api/desktop/shared-files/media?path=reports%2Fteam.png'), true)
        assert.deepEqual(new Uint8Array(await readFile(filePath)), pngBytes)
    } finally { await rm(root, { recursive: true, force: true }) }
})

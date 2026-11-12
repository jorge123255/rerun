import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, symlink, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDesktopFileSaves, createDesktopResultFileSave } from '../src/main/result-files.mjs'

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

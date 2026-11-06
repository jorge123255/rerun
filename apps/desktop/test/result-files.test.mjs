import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, symlink, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDesktopResultFileSave } from '../src/main/result-files.mjs'

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

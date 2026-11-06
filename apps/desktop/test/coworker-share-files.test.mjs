import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDesktopCoworkerShareFiles } from '../src/main/coworker-share-files.mjs'
const bytes = Buffer.from('reviewed local portable coworker archive bytes')
const runtime = () => ({ app: { origin: 'http://127.0.0.1:43333' },engine: { apiKey: 'fake-engine-key' } })
test('imports only native-selected bytes through authenticated local staging and returns an opaque receipt', async () => {
    const directory = await mkdtemp(join(tmpdir(),'share-file-'))
    try {
        const path = join(directory,'Coworker.tar.gz'); await writeFile(path,bytes)
        const owner = { runtime: runtime(),window: {} }; let calls = 0
        const api = createDesktopCoworkerShareFiles({ context: () => owner,
            dialog: { showOpenDialog: async () => ({ canceled: false,filePaths: [path] }) },
            fetch: async (url,options) => {
                calls++; assert.equal(url.href,`${owner.runtime.app.origin}/api/desktop/internal/coworker-share/ingest`)
                assert.equal(options.headers.Authorization,'Bearer fake-engine-key'); assert.equal(options.redirect,'error')
                assert.deepEqual(options.body,bytes)
                return Response.json({ snapshotId: 'a'.repeat(32) })
            },
        })
        assert.deepEqual(await api.pickImport(),{ snapshotId: 'a'.repeat(32),fileName: 'Coworker.tar.gz' })
        assert.equal(calls,1)
        const link = join(directory,'Alias.tar.gz'); await symlink(path,link)
        const linked = createDesktopCoworkerShareFiles({ context: () => owner,dialog: { showOpenDialog: async () => ({ canceled: false,filePaths: [link] }) },fetch: async () => { throw new Error('must not upload symlink') } })
        await assert.rejects(linked.pickImport())
    } finally { await rm(directory,{ recursive: true,force: true }) }
})
test('workspace replacement while picking aborts before reading or uploading', async () => {
    let owner = { runtime: runtime(),window: {} },calls = 0
    const api = createDesktopCoworkerShareFiles({ context: () => owner,
        dialog: { showOpenDialog: async () => { owner = { ...owner,runtime: runtime() }; return { canceled: false,filePaths: ['/not-read.tar.gz'] } } },
        fetch: async () => { calls++;throw new Error('not reached') },
    })
    await assert.rejects(api.pickImport(),/workspace changed/);assert.equal(calls,0)
})

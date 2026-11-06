import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { createDesktopTemplateFiles } from '../src/main/templates.mjs'

const runtime = () => ({ engine: { origin: 'http://127.0.0.1:41111', apiKey: 'test-local-key' } })
const bytes = Buffer.from('test portable package bytes for selected file')
const metadata = { artifactId: 'a'.repeat(32), fileName: 'Team.tar.gz', bytes: bytes.length, archiveDigest: createHash('sha256').update(bytes).digest('hex') }

test('native import sends only the explicitly selected bytes to the authenticated local engine', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'template-dialog-'))
    try {
        const path = join(directory, 'Selected.tar.gz')
        await writeFile(path, bytes)
        const owner = { runtime: runtime(), window: {} }
        let calls = 0
        const files = createDesktopTemplateFiles({ context: () => owner,
            dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: [path] }) },
            fetch: async (url, options) => {
                calls++
                assert.equal(url.origin, owner.runtime.engine.origin)
                assert.match(url.pathname, /^\/desktop\/templates\/uploads\/[a-f0-9-]{36}$/)
                assert.equal(options.headers.Authorization, 'Bearer test-local-key')
                assert.equal(options.redirect, 'error')
                assert.deepEqual(options.body, bytes)
                return Response.json({ uploadId: url.pathname.split('/').at(-1), fileName: 'Selected.tar.gz', bytes: bytes.length })
            },
        })
        const picked = await files.pickImport()
        assert.equal(calls, 1)
        assert.equal(picked.fileName, 'Selected.tar.gz')
        assert.equal('path' in picked, false)
        assert.equal('apiKey' in picked, false)
    } finally { await rm(directory, { recursive: true, force: true }) }
})

test('a restart while the picker is open rejects before upload', async () => {
    let owner = { runtime: runtime(), window: {} }
    let calls = 0
    const files = createDesktopTemplateFiles({ context: () => owner,
        dialog: { showOpenDialog: async () => { owner = { ...owner, runtime: runtime() }; return { canceled: false, filePaths: ['/never/read'] } } },
        fetch: async () => { calls++; throw new Error('Unexpected upload') },
    })
    await assert.rejects(files.pickImport(), /workspace changed/)
    assert.equal(calls, 0)
})

test('export writes verified artifact bytes only to the native save choice and rejects symlink destinations', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'template-save-'))
    try {
        const path = join(directory, 'Team.tar.gz'), outside = join(directory, 'Existing.txt'), link = join(directory, 'Link.tar.gz')
        await writeFile(outside, 'keep original')
        await symlink(outside, link)
        let selected = path
        const owner = { runtime: runtime(), window: {} }
        const files = createDesktopTemplateFiles({ context: () => owner,
            dialog: { showSaveDialog: async () => ({ canceled: false, filePath: selected }) },
            fetch: async url => url.pathname.endsWith('/content') ? new Response(bytes) : Response.json(metadata),
        })
        await assert.rejects(files.saveArtifact({ artifactId: metadata.artifactId, path: outside }), /Invalid template download/)
        assert.deepEqual(await files.saveArtifact({ artifactId: metadata.artifactId }), { saved: true })
        assert.deepEqual(await readFile(path), bytes)
        selected = link
        await assert.rejects(files.saveArtifact({ artifactId: metadata.artifactId }), /regular file location/)
        assert.equal(await readFile(outside, 'utf8'), 'keep original')
    } finally { await rm(directory, { recursive: true, force: true }) }
})

test('tampered artifact bytes never create the native save file', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'template-tamper-'))
    try {
        const path = join(directory, 'Team.tar.gz'), owner = { runtime: runtime(), window: {} }
        const files = createDesktopTemplateFiles({ context: () => owner,
            dialog: { showSaveDialog: async () => ({ canceled: false, filePath: path }) },
            fetch: async url => url.pathname.endsWith('/content') ? new Response(Buffer.alloc(bytes.length)) : Response.json(metadata),
        })
        await assert.rejects(files.saveArtifact({ artifactId: metadata.artifactId }), /download changed/)
        await assert.rejects(readFile(path), { code: 'ENOENT' })
    } finally { await rm(directory, { recursive: true, force: true }) }
})

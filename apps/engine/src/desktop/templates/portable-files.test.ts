import { randomUUID } from 'node:crypto'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, afterEach, beforeEach, expect, test } from 'vitest'
import { createDesktopPortableFileStore, initializeDesktopPortableFiles } from './portable-files.js'
import { prepareSkillHelperFixture } from '../skill-publication.test-support.js'

let helper: Awaited<ReturnType<typeof prepareSkillHelperFixture>>
const previousHelper = process.env.RERUN_DESKTOP_RENAME_HELPER
beforeAll(async () => { helper = await prepareSkillHelperFixture(); process.env.RERUN_DESKTOP_RENAME_HELPER = helper.path }, 30_000)
afterAll(async () => {
    if (previousHelper === undefined) delete process.env.RERUN_DESKTOP_RENAME_HELPER
    else process.env.RERUN_DESKTOP_RENAME_HELPER = previousHelper
    await helper.close()
})

let root: string
beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'portable-files-')))
    await writeFile(join(root, 'desktop-owner.json'), JSON.stringify({ installId: randomUUID(), workspaceId: 1 }))
    await initializeDesktopPortableFiles(root)
})
afterEach(async () => { await rm(root, { recursive: true, force: true }) })
const bytes = Buffer.from('immutable portable template archive fixture bytes')
const identity = () => ({ requestId: randomUUID(), templateId: 'a'.repeat(32), revision: 'b'.repeat(64), contentDigest: 'c'.repeat(64) })

test('same upload identity survives recreation but cannot bind different bytes or filename', async () => {
    const uploadId = randomUUID()
    await createDesktopPortableFileStore(root).upload(uploadId, bytes, 'Team.tar.gz')
    const reopened = createDesktopPortableFileStore(root)
    expect(await reopened.readImmutableUpload(uploadId)).toEqual(bytes)
    await expect(reopened.upload(uploadId, Buffer.alloc(bytes.length), 'Team.tar.gz')).rejects.toThrow(/other bytes/)
    await expect(reopened.upload(uploadId, bytes, 'Other.tar.gz')).rejects.toThrow(/other bytes/)
})

test('artifact recovery returns the same opaque ID after recreation and detects changed bytes', async () => {
    const source = identity()
    const published = await createDesktopPortableFileStore(root).publishDownloadArtifact(bytes, 'Team.tar.gz', source)
    const reopened = createDesktopPortableFileStore(root)
    expect(await reopened.findDownloadArtifact(source)).toMatchObject(published)
    expect(await reopened.publishDownloadArtifact(bytes, 'Team.tar.gz', source)).toEqual(published)
    expect((await reopened.download(published.artifactId)).bytes).toEqual(bytes)
    await writeFile(join(root, 'desktop-templates', 'portable-io', 'artifacts', published.artifactId, 'archive.tar.gz'), Buffer.alloc(bytes.length))
    await expect(reopened.findDownloadArtifact(source)).rejects.toThrow(/no longer match/)
})

test('rebound workspace cannot recover or read another owner’s upload or artifact', async () => {
    const source = identity(), uploadId = randomUUID(), store = createDesktopPortableFileStore(root)
    await store.upload(uploadId, bytes, 'Team.tar.gz')
    const published = await store.publishDownloadArtifact(bytes, 'Team.tar.gz', source)
    await writeFile(join(root, 'desktop-owner.json'), JSON.stringify({ installId: randomUUID(), workspaceId: 1 }))
    await expect(store.readImmutableUpload(uploadId)).rejects.toThrow(/another workspace/)
    await expect(store.findDownloadArtifact(source)).rejects.toThrow(/another workspace/)
    await expect(store.download(published.artifactId)).rejects.toThrow(/another workspace/)
})


test('portable receipts remain bound to a non-legacy workspace across restart', async () => {
    const installId = randomUUID()
    await writeFile(join(root, 'desktop-owner.json'), JSON.stringify({ installId, workspaceId: 7 }))
    const uploadId = randomUUID()
    await createDesktopPortableFileStore(root).upload(uploadId, bytes, 'Team.tar.gz')
    expect(await createDesktopPortableFileStore(root).readImmutableUpload(uploadId)).toEqual(bytes)
    await writeFile(join(root, 'desktop-owner.json'), JSON.stringify({ installId, workspaceId: 8 }))
    await expect(createDesktopPortableFileStore(root).readImmutableUpload(uploadId)).rejects.toThrow('another workspace')
})

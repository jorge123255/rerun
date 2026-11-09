import { expect, test } from 'vitest'
import type { DesktopCoworkerShareSource } from '@rerun/contracts'
import { createDesktopCoworkerSnapshot } from '../../../../../engine/src/desktop/coworker-share/snapshot'
import { createHash } from 'node:crypto'
import { readPortableArchive, sealPortableManifest, writePortableArchive } from '../../../../../engine/src/desktop/templates/portable-package'
import { serializeMemoryNote, renderMemoryMarkdown } from '../../../../../engine/src/desktop/coworker-share-memory/serialize'
import { memoryPreviewFromSource, prepareMemoryShareImport } from './memories'

function source(content = 'Keep the same identity.'): DesktopCoworkerShareSource {
    const note = serializeMemoryNote({ id: 'note', kind: 'preference', tags: ['project'], createdAt: '2026-01-02T03:04:05Z', content })
    const file = (path: string, bytes: Buffer) => ({ path, bytes: new Uint8Array(bytes), kind: 'text' as const, binary: false, textScanned: true, flagged: [], ownership: 'user' as const })
    return { workspaceId: 1, agentId: 'source', name: 'Ada', description: 'Notes', revision: 'a'.repeat(64), setup: { required: false, prompt: '', answered: false }, config: {}, envKeys: [], mcpAuth: [], members: [file('SOUL.md',Buffer.from('Keep notes.')), { ...file('config.json',Buffer.from(JSON.stringify({ name: 'source', displayName: 'Ada', enabled: false, kind: 'user', ephemeral: false, tools: {}, mcpServers: [], selfImprovement: {}, setup: { required: false, completedAt: null, sessionId: null } }))), kind: 'config' }, file('memory/note.md',Buffer.from(renderMemoryMarkdown(note)))] }
}

test('exact review counts/digest survive the canonical template-only projection without editing the original share', async () => {
    const current = source()
    const snapshot = await createDesktopCoworkerSnapshot(current,{ memories: true, database: false, files: false })
    const prepared = await prepareMemoryShareImport(snapshot.archiveBytes,7,'same-import')
    expect(prepared.memories?.contents).toEqual(memoryPreviewFromSource(current).contents)
    expect(prepared.memories?.digest).toBe(memoryPreviewFromSource(current).digest)
    expect((await readPortableArchive(prepared.templateBytes)).members.map(member => member.path)).toEqual(['SOUL.md','config.json'])
    expect((await readPortableArchive(snapshot.archiveBytes)).members.some(member => member.path === 'memory/note.md')).toBe(true)
    expect((await prepareMemoryShareImport(snapshot.archiveBytes,7,'same-import')).memories).toEqual(prepared.memories)
    expect(snapshot.manifest.excludedCategories).not.toContain('private-memory')
})

test('an externally assembled archive cannot send a raw SQLite file to the template installer', async () => {
    const snapshot = await createDesktopCoworkerSnapshot(source(), { memories: false, database: false, files: false })
    const raw = Buffer.from('SQLite format 3\0')
    const member = { agentKey: 'c01', path: 'data/agent.db', bytes: raw, digest: createHash('sha256').update(raw).digest('hex') }
    const { contentDigest: _digest, ...body } = snapshot.manifest
    const manifest = sealPortableManifest({
        ...body,
        coworkers: body.coworkers.map(owner => ({ ...owner, members: [...owner.members, {
            path: member.path, bytes: raw.length, contentDigest: member.digest,
            kind: 'binary', binary: true, textScanned: false, flagged: [],
        }] })),
    })
    const archive = await writePortableArchive({ title: manifest.title, packageKey: manifest.packageKey, manifest, members: [...snapshot.members, member], startedAt: Date.now() })
    await expect(prepareMemoryShareImport(archive.archiveBytes, 7, 'database')).rejects.toMatchObject({ status: 409 })
})

test('flagged memories count as excluded; an external manifest cannot claim credential bytes are clean', async () => {
    const current = source(`Bearer ${'x'.repeat(32)}`)
    current.members[2]!.flagged = ['Bearer token']
    expect(memoryPreviewFromSource(current).contents).toEqual({ count: 0, bytes: 0 })
    const safe = await createDesktopCoworkerSnapshot(current,{ memories: true, database: false, files: false })
    expect(safe.members.some(member => member.path.startsWith('memory/'))).toBe(false)
    expect(safe.manifest.coworkers[0]!.exclusions).toContainEqual({ path: 'memory/note.md', reason: 'credentials' })
    current.members[2]!.flagged = []
    const falselyClaimed = await createDesktopCoworkerSnapshot(current,{ memories: true, database: false, files: false })
    await expect(prepareMemoryShareImport(falselyClaimed.archiveBytes,7,'untrusted')).rejects.toMatchObject({ status: 409 })
})

test('noncanonical memory metadata is not silently rewritten after review', async () => {
    const current = source()
    current.members[2]!.bytes = Buffer.concat([current.members[2]!.bytes,Buffer.from('\n')])
    const snapshot = await createDesktopCoworkerSnapshot(current,{ memories: true, database: false, files: false })
    await expect(prepareMemoryShareImport(snapshot.archiveBytes,7,'altered')).rejects.toMatchObject({ status: 409 })
})

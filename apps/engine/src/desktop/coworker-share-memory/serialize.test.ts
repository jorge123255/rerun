import { expect, test } from 'vitest'
import { DesktopCoworkerShareMemoryError } from './errors.ts'
import {
    digestNoteContent,
    measureNotes,
    memoryMemberPath,
    packageDigest,
    parseMemoryMarkdown,
    renderMemoryMarkdown,
    serializeMemoryNote,
} from './serialize.ts'
import { memoryArchiveMembersToNotes, memoryPackageToArchiveMembers } from './members.ts'
import {
    DESKTOP_COWORKER_SHARE_MEMORY_FORMAT,
    DESKTOP_COWORKER_SHARE_MEMORY_FORMAT_VERSION,
} from '../../../../../packages/contracts/src/desktop-coworker-share-memory.ts'

const sample = {
    id: 'note1',
    kind: 'note',
    tags: ['alpha'],
    createdAt: '2026-11-06T12:00:00.000Z',
    content: 'Remember the printer code.',
}

test('serializes canonical note metadata and binds content digest', () => {
    const note = serializeMemoryNote(sample)
    expect(note.contentDigest).toBe(digestNoteContent(sample))
    expect(memoryMemberPath(note.id)).toBe('memory/note1.md')
    const roundTrip = parseMemoryMarkdown(memoryMemberPath(note.id), renderMemoryMarkdown(note))
    expect(roundTrip).toEqual(note)
})

test('rejects path escapes and reserved ids', () => {
    expect(() => memoryMemberPath('../x')).toThrow(DesktopCoworkerShareMemoryError)
    expect(() => memoryMemberPath('recall')).toThrow(DesktopCoworkerShareMemoryError)
    expect(() => memoryMemberPath('a/b')).toThrow(DesktopCoworkerShareMemoryError)
    expect(() => parseMemoryMarkdown('memory/../note1.md', renderMemoryMarkdown(serializeMemoryNote(sample)))).toThrow(DesktopCoworkerShareMemoryError)
})

test('package digest is stable for the same reviewed notes regardless of input order', () => {
    const a = serializeMemoryNote(sample)
    const b = serializeMemoryNote({ ...sample, id: 'note2', content: 'Second note' })
    expect(packageDigest([b, a])).toBe(packageDigest([a, b]))
    expect(measureNotes([a, b]).count).toBe(2)
    expect(measureNotes([a, b]).bytes).toBeGreaterThan(0)
})

test('archive members round-trip without embeddings or runtime stats', () => {
    const note = serializeMemoryNote(sample)
    const pkg = {
        format: DESKTOP_COWORKER_SHARE_MEMORY_FORMAT,
        formatVersion: DESKTOP_COWORKER_SHARE_MEMORY_FORMAT_VERSION,
        sourceWorkspaceId: 1,
        sourceAgentId: 'agent-a',
        captureRequestId: 'capture-1',
        capturedAt: sample.createdAt,
        notes: [note],
        contents: measureNotes([note]),
        digest: packageDigest([note]),
    } as const
    const members = memoryPackageToArchiveMembers(pkg)
    expect(members).toEqual([{ path: 'memory/note1.md', bytes: expect.any(Buffer) }])
    expect(members[0]!.bytes.includes(Buffer.from('embedding'))).toBe(false)
    expect(memoryArchiveMembersToNotes(members)).toEqual([note])
})

import { expect, test } from 'vitest'
import { captureDesktopCoworkerShareMemory } from './capture.ts'
import { previewDesktopCoworkerShareMemory } from './preview.ts'
import { restoreDesktopCoworkerShareMemory } from './restore.ts'
import { DesktopCoworkerShareMemoryError } from './errors.ts'
import { createDesktopCoworkerShareMemoryInstallAdapter } from './adapters.ts'
import { serializeMemoryNote } from './serialize.ts'

const notes = [
    { id: 'n1', kind: 'note', tags: ['t'], createdAt: '2026-11-06T12:00:00.000Z', content: 'Alpha' },
    { id: 'n2', kind: 'fact', tags: [], createdAt: '2026-11-06T12:01:00.000Z', content: 'Beta' },
]

test('preview counts bind to exact reviewed content digest', () => {
    const preview = previewDesktopCoworkerShareMemory(notes)
    expect(preview.available).toBe(true)
    expect(preview.contents.count).toBe(2)
    expect(preview.digest).toMatch(/^[a-f0-9]{64}$/)
    const unavailable = previewDesktopCoworkerShareMemory(notes, { available: false, reason: 'Memory transfer is unavailable in this version.' })
    expect(unavailable).toMatchObject({ available: false, contents: { count: 0, bytes: 0 }, digest: null })
})

test('capture fails closed without authority and skips when memories not included', async () => {
    await expect(captureDesktopCoworkerShareMemory(null, { requestId: 'r1', includeMemories: true })).resolves.toMatchObject({ unavailable: true })
    await expect(captureDesktopCoworkerShareMemory({
        workspaceId: 1,
        agentId: 'agent-a',
        listOwnedNotes: async () => notes,
    }, { requestId: 'r1', includeMemories: false })).resolves.toMatchObject({ unavailable: true })
})

test('capture produces revision-bound package from owned notes only', async () => {
    const listed: typeof notes = []
    const pkg = await captureDesktopCoworkerShareMemory({
        workspaceId: 1,
        agentId: 'agent-a',
        listOwnedNotes: async () => {
            listed.push(...notes)
            return notes
        },
    }, { requestId: 'capture-req', includeMemories: true, capturedAt: '2026-11-06T13:00:00.000Z' })
    if ('unavailable' in pkg) throw new Error('expected package')
    expect(pkg.captureRequestId).toBe('capture-req')
    expect(pkg.notes.map(note => note.id)).toEqual(['n1', 'n2'])
    expect(pkg.digest).toMatch(/^[a-f0-9]{64}$/)
    expect(listed).toHaveLength(2)
})

test('restore fails closed without install authority and rejects stale digest', async () => {
    const captured = await captureDesktopCoworkerShareMemory({
        workspaceId: 1,
        agentId: 'agent-a',
        listOwnedNotes: async () => notes,
    }, { requestId: 'capture-req', includeMemories: true, capturedAt: '2026-11-06T13:00:00.000Z' })
    if ('unavailable' in captured) throw new Error('expected package')
    const unavailable = await restoreDesktopCoworkerShareMemory(null, captured, {
        captureRequestId: 'capture-req',
        expectedDigest: captured.digest,
    })
    expect(unavailable.status).toBe('unavailable')
    await expect(restoreDesktopCoworkerShareMemory({
        workspaceId: 1,
        destinationAgentId: 'agent-b',
        assertFreshDestination: async () => {},
        installNote: async () => 'installed',
    }, captured, { captureRequestId: 'capture-req', expectedDigest: '0'.repeat(64) })).rejects.toBeInstanceOf(DesktopCoworkerShareMemoryError)
})

test('restore installs into fresh destination with durable retry reuse and no duplicate notes', async () => {
    const captured = await captureDesktopCoworkerShareMemory({
        workspaceId: 1,
        agentId: 'agent-a',
        listOwnedNotes: async () => notes,
    }, { requestId: 'capture-req', includeMemories: true, capturedAt: '2026-11-06T13:00:00.000Z' })
    if ('unavailable' in captured) throw new Error('expected package')

    const writes: string[] = []
    const authority = {
        workspaceId: 1,
        destinationAgentId: 'agent-b',
        assertFreshDestination: async () => {},
        installNote: async ({ note, captureRequestId }: { note: { id: string }; captureRequestId: string }) => {
            const key = `${captureRequestId}:${note.id}`
            if (writes.includes(key)) return 'reused' as const
            writes.push(key)
            return 'installed' as const
        },
    }
    const first = await restoreDesktopCoworkerShareMemory(authority, captured, {
        captureRequestId: 'capture-req',
        expectedDigest: captured.digest,
    })
    expect(first).toMatchObject({ status: 'installed', installedCount: 2, reusedCount: 0, destinationAgentId: 'agent-b' })
    const second = await restoreDesktopCoworkerShareMemory(authority, captured, {
        captureRequestId: 'capture-req',
        expectedDigest: captured.digest,
    })
    expect(second).toMatchObject({ status: 'reused', installedCount: 0, reusedCount: 2 })
    expect(writes).toEqual(['capture-req:n1', 'capture-req:n2'])
})

test('install adapter refuses missing writer', () => {
    expect(() => createDesktopCoworkerShareMemoryInstallAdapter({
        workspaceId: 1,
        destinationAgentId: 'agent-b',
        writeNote: null,
    })).toThrow(DesktopCoworkerShareMemoryError)
})

test('duplicate note ids are rejected during capture serialization', async () => {
    await expect(captureDesktopCoworkerShareMemory({
        workspaceId: 1,
        agentId: 'agent-a',
        listOwnedNotes: async () => [notes[0]!, notes[0]!],
    }, { requestId: 'dup', includeMemories: true })).rejects.toBeInstanceOf(DesktopCoworkerShareMemoryError)
    expect(serializeMemoryNote(notes[0]!).id).toBe('n1')
})

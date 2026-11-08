import {
    DESKTOP_COWORKER_SHARE_MEMORY_LIMITS,
    desktopCoworkerShareMemoryPreviewSchema,
    type DesktopCoworkerShareMemoryNote,
    type DesktopCoworkerShareMemoryPreview,
} from '@rerun/contracts'
import { DesktopCoworkerShareMemoryError } from './errors.ts'
import { measureNotes, packageDigest, serializeMemoryNote, type DesktopCoworkerShareMemoryNoteInput } from './serialize.ts'

export function previewDesktopCoworkerShareMemory(
    inputs: readonly DesktopCoworkerShareMemoryNoteInput[],
    options?: { available?: boolean; reason?: string },
): DesktopCoworkerShareMemoryPreview {
    if (options?.available === false) {
        return desktopCoworkerShareMemoryPreviewSchema.parse({
            available: false,
            reason: options.reason ?? 'Memory transfer is unavailable.',
            contents: { count: 0, bytes: 0 },
            digest: null,
        })
    }
    const notes: DesktopCoworkerShareMemoryNote[] = []
    const seen = new Set<string>()
    for (const input of inputs) {
        const note = serializeMemoryNote(input)
        if (seen.has(note.id)) throw new DesktopCoworkerShareMemoryError('invalid', 'Duplicate memory note id in capture.')
        seen.add(note.id)
        notes.push(note)
    }
    if (notes.length > DESKTOP_COWORKER_SHARE_MEMORY_LIMITS.maxNotes) {
        throw new DesktopCoworkerShareMemoryError('bounds', 'Too many memory notes for a portable share.')
    }
    const contents = measureNotes(notes)
    if (contents.bytes > DESKTOP_COWORKER_SHARE_MEMORY_LIMITS.maxTotalBytes) {
        throw new DesktopCoworkerShareMemoryError('bounds', 'Memory notes exceed the portable total size limit.')
    }
    return desktopCoworkerShareMemoryPreviewSchema.parse({
        available: true,
        contents,
        digest: notes.length ? packageDigest(notes) : null,
    })
}

import {
    DESKTOP_COWORKER_SHARE_MEMORY_FORMAT,
    DESKTOP_COWORKER_SHARE_MEMORY_FORMAT_VERSION,
    DESKTOP_COWORKER_SHARE_MEMORY_LIMITS,
    desktopCoworkerShareMemoryPackageSchema,
    type DesktopCoworkerShareMemoryNote,
    type DesktopCoworkerShareMemoryPackage,
} from '@rerun/contracts'
import { DesktopCoworkerShareMemoryError } from './errors.ts'
import { measureNotes, packageDigest, serializeMemoryNote, type DesktopCoworkerShareMemoryNoteInput } from './serialize.ts'

export type DesktopCoworkerShareMemoryCaptureAuthority = {
    workspaceId: number
    agentId: string
    /** Observational read of this coworker's own canonical notes only. */
    listOwnedNotes: () => Promise<readonly DesktopCoworkerShareMemoryNoteInput[]>
}

export type DesktopCoworkerShareMemoryCaptureInput = {
    requestId: string
    includeMemories: boolean
    capturedAt?: string
}

export async function captureDesktopCoworkerShareMemory(
    authority: DesktopCoworkerShareMemoryCaptureAuthority | null | undefined,
    input: DesktopCoworkerShareMemoryCaptureInput,
): Promise<DesktopCoworkerShareMemoryPackage | { unavailable: true; reason: string }> {
    if (!input.includeMemories) {
        return { unavailable: true, reason: 'Memories were not selected for this share.' }
    }
    if (!authority) {
        return { unavailable: true, reason: 'Memory transfer is unavailable until the canonical note authority is bound.' }
    }
    if (!input.requestId || input.requestId.length > DESKTOP_COWORKER_SHARE_MEMORY_LIMITS.maxRequestIdLength) {
        throw new DesktopCoworkerShareMemoryError('invalid', 'Capture request id is missing or too long.')
    }
    const listed = await authority.listOwnedNotes()
    const notes: DesktopCoworkerShareMemoryNote[] = []
    const seen = new Set<string>()
    for (const raw of listed) {
        const note = serializeMemoryNote(raw)
        if (seen.has(note.id)) throw new DesktopCoworkerShareMemoryError('invalid', 'Duplicate memory note id in capture.')
        seen.add(note.id)
        notes.push(note)
    }
    notes.sort((left, right) => left.id.localeCompare(right.id))
    if (notes.length > DESKTOP_COWORKER_SHARE_MEMORY_LIMITS.maxNotes) {
        throw new DesktopCoworkerShareMemoryError('bounds', 'Too many memory notes for a portable share.')
    }
    const contents = measureNotes(notes)
    if (contents.bytes > DESKTOP_COWORKER_SHARE_MEMORY_LIMITS.maxTotalBytes) {
        throw new DesktopCoworkerShareMemoryError('bounds', 'Memory notes exceed the portable total size limit.')
    }
    return desktopCoworkerShareMemoryPackageSchema.parse({
        format: DESKTOP_COWORKER_SHARE_MEMORY_FORMAT,
        formatVersion: DESKTOP_COWORKER_SHARE_MEMORY_FORMAT_VERSION,
        sourceWorkspaceId: authority.workspaceId,
        sourceAgentId: authority.agentId,
        captureRequestId: input.requestId,
        capturedAt: input.capturedAt ?? new Date().toISOString(),
        notes,
        contents,
        digest: packageDigest(notes),
    })
}

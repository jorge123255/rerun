import { basename } from 'node:path'
import { listDesktopMemory } from '../memory-store.ts'
import { DesktopCoworkerShareMemoryError } from './errors.ts'
import type { DesktopCoworkerShareMemoryCaptureAuthority } from './capture.ts'
import type { DesktopCoworkerShareMemoryInstallAuthority } from './restore.ts'
import type { DesktopCoworkerShareMemoryNoteInput } from './serialize.ts'
import { digestNoteContent } from './serialize.ts'

const NOTE_ID = /^[A-Za-z0-9_-]+$/

function isCanonicalFile(file: { id: string; path: string; content: string; kind: string; tags: string[]; createdAt: string }): boolean {
    if (!NOTE_ID.test(file.id) || file.id === 'recall') return false
    if (basename(file.path) !== `${file.id}.md`) return false
    if (file.path.includes('\\') || file.path.includes('\0')) return false
    const parts = file.path.split(/[/\\]/)
    if (parts.some(part =>
        part === '..'
        || part === '.rerun'
        || part.startsWith('.rerun-skill-')
        || part.startsWith('.adding-')
        || part.startsWith('.deleting-')
        || part.startsWith('.writing-')
        || part.startsWith('.updating-')
        || part === '.clearing'
        || part === 'archive'
    )) return false
    if (!file.content.trim()) return false
    return true
}

/** Concrete observational adapter over the canonical desktop memory store. Source notes stay unchanged. */
export function createDesktopCoworkerShareMemoryCaptureAdapter(input: {
    workspaceId: number
    agentId: string
}): DesktopCoworkerShareMemoryCaptureAuthority {
    return {
        workspaceId: input.workspaceId,
        agentId: input.agentId,
        async listOwnedNotes() {
            const [files] = await listDesktopMemory(input.agentId)
            const notes: DesktopCoworkerShareMemoryNoteInput[] = []
            for (const file of files) {
                if (!isCanonicalFile(file)) continue
                notes.push({
                    id: file.id,
                    kind: file.kind || 'note',
                    tags: file.tags ?? [],
                    createdAt: file.createdAt,
                    content: file.content.trim(),
                })
            }
            return notes
        },
    }
}

export type DesktopCoworkerShareMemoryNoteWriter = (input: {
    destinationAgentId: string
    note: {
        id: string
        kind: string
        tags: string[]
        createdAt: string
        content: string
    }
    recoveryKey: string
}) => Promise<'installed' | 'reused'>

/**
 * Concrete install adapter. Fails closed unless a note writer is supplied by root
 * (typically wrapping addDesktopMemory / indexMemory while preserving note ids).
 * Asserts the destination lists zero canonical notes before the first install of a request.
 */
export function createDesktopCoworkerShareMemoryInstallAdapter(input: {
    workspaceId: number
    destinationAgentId: string
    writeNote: DesktopCoworkerShareMemoryNoteWriter | null | undefined
}): DesktopCoworkerShareMemoryInstallAuthority {
    if (!input.writeNote) {
        throw new DesktopCoworkerShareMemoryError('unavailable', 'Memory restore is unavailable until the canonical install writer is bound.')
    }
    const writeNote = input.writeNote
    const seen = new Map<string, 'installed' | 'reused'>()
    return {
        workspaceId: input.workspaceId,
        destinationAgentId: input.destinationAgentId,
        async assertFreshDestination() {
            const [files] = await listDesktopMemory(input.destinationAgentId)
            const existing = files.filter(isCanonicalFile)
            if (existing.length > 0) {
                throw new DesktopCoworkerShareMemoryError('conflict', 'Memory restore requires a fresh destination coworker with no existing notes.')
            }
        },
        async installNote({ captureRequestId, packageDigest, note }) {
            const expected = digestNoteContent(note)
            if (expected !== note.contentDigest) {
                throw new DesktopCoworkerShareMemoryError('invalid', 'Memory note digest mismatch during install.')
            }
            const recoveryKey = `${captureRequestId}:${packageDigest}:${note.id}:${note.contentDigest}`
            const prior = seen.get(recoveryKey)
            if (prior) return prior
            const outcome = await writeNote({
                destinationAgentId: input.destinationAgentId,
                note: {
                    id: note.id,
                    kind: note.kind,
                    tags: note.tags,
                    createdAt: note.createdAt,
                    content: note.content,
                },
                recoveryKey,
            })
            seen.set(recoveryKey, outcome)
            return outcome
        },
    }
}

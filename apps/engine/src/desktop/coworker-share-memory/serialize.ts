import matter from 'gray-matter'
import {
    DESKTOP_COWORKER_SHARE_MEMORY_LIMITS,
    desktopCoworkerShareMemoryNoteSchema,
    type DesktopCoworkerShareMemoryNote,
} from '../../../../../packages/contracts/src/desktop-coworker-share-memory.ts'
import { DesktopCoworkerShareMemoryError } from './errors.ts'
import { canonicalJson, sha256Hex } from './hash.ts'

const NOTE_ID = /^[A-Za-z0-9_-]+$/
const MEMBER_PATH = /^memory\/[A-Za-z0-9_-]+\.md$/

export type DesktopCoworkerShareMemoryNoteInput = {
    id: string
    kind: string
    tags: readonly string[]
    createdAt: string
    content: string
}

export function memoryMemberPath(id: string): string {
    if (!NOTE_ID.test(id) || id === 'recall' || id.includes('/') || id.includes('\\') || id.includes('..')) {
        throw new DesktopCoworkerShareMemoryError('invalid', 'Memory note id is not a safe portable path.')
    }
    return `memory/${id}.md`
}

export function digestNoteContent(input: DesktopCoworkerShareMemoryNoteInput): string {
    return sha256Hex(canonicalJson({
        id: input.id,
        kind: input.kind,
        tags: [...input.tags],
        createdAt: input.createdAt,
        content: input.content.trim(),
    }))
}

export function serializeMemoryNote(input: DesktopCoworkerShareMemoryNoteInput): DesktopCoworkerShareMemoryNote {
    const note = desktopCoworkerShareMemoryNoteSchema.parse({
        id: input.id,
        kind: input.kind.trim() || 'note',
        tags: [...input.tags],
        createdAt: input.createdAt,
        content: input.content.trim(),
        contentDigest: digestNoteContent(input),
    })
    const bytes = Buffer.byteLength(renderMemoryMarkdown(note), 'utf8')
    if (bytes > DESKTOP_COWORKER_SHARE_MEMORY_LIMITS.maxNoteBytes) {
        throw new DesktopCoworkerShareMemoryError('bounds', 'A memory note exceeds the portable size limit.')
    }
    return note
}

export function renderMemoryMarkdown(note: DesktopCoworkerShareMemoryNote): string {
    return matter.stringify(`\n${note.content}\n`, {
        id: note.id,
        kind: note.kind,
        tags: note.tags,
        createdAt: note.createdAt,
    })
}

export function parseMemoryMarkdown(path: string, text: string): DesktopCoworkerShareMemoryNote {
    if (!MEMBER_PATH.test(path)) {
        throw new DesktopCoworkerShareMemoryError('invalid', 'Memory member path escaped the portable memory prefix.')
    }
    const idFromPath = path.slice('memory/'.length, -'.md'.length)
    const parsed = matter(text, {
        engines: {
            javascript: () => {
                throw new DesktopCoworkerShareMemoryError('invalid', 'Executable memory metadata is unsupported.')
            },
        },
    })
    const data = parsed.data as Record<string, unknown>
    const id = typeof data.id === 'string' ? data.id : ''
    if (id !== idFromPath) throw new DesktopCoworkerShareMemoryError('invalid', 'Memory note id does not match its portable path.')
    return serializeMemoryNote({
        id,
        kind: typeof data.kind === 'string' ? data.kind : 'note',
        tags: Array.isArray(data.tags) ? data.tags.map(String) : [],
        createdAt: typeof data.createdAt === 'string' ? data.createdAt : '',
        content: parsed.content.trim(),
    })
}

export function packageDigest(notes: readonly DesktopCoworkerShareMemoryNote[]): string {
    const ordered = [...notes].sort((left, right) => left.id.localeCompare(right.id))
    return sha256Hex(canonicalJson(ordered.map(note => [note.id, note.contentDigest, note.kind, note.tags, note.createdAt])))
}

export function measureNotes(notes: readonly DesktopCoworkerShareMemoryNote[]): { count: number; bytes: number } {
    let bytes = 0
    for (const note of notes) bytes += Buffer.byteLength(renderMemoryMarkdown(note), 'utf8')
    return { count: notes.length, bytes }
}

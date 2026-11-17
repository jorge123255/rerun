// Attachments reach the agent as workspace paths it can open, but the bubble has to show the
// files, and the engine only ever stores the message text (no per-message metadata column). So
// the paths travel as a marker appended to the text, the same trick as the voice marker (see
// apps/ui/lib/voice/marker.ts). The wording is agent-facing prose on purpose: it is what tells
// the model the files are there.
//
// This lives in contracts because both the web composer and the iOS one write it.
const BLOCK = /\n*\[Attachments added to your workspace: ([^\]\n]+)\]\s*$/

// Paths are joined with ', '. A filename carrying that exact sequence would split into two
// entries, which shows one broken tile and leaves the text intact. That beats escaping prose the
// agent is meant to read.
const SEPARATOR = ', '

export const CHAT_ATTACHMENTS_DIR = 'chat-uploads'

// Display strips this prefix back off (see attachmentDisplayName).
const UNIQUE_PREFIX = /^[0-9a-z]{8,9}-[A-Za-z0-9_-]{6}-/

// The agent reads what lands in chat-uploads/ by path, so two files sharing a name would shadow
// each other. `token` must be 6 characters of [A-Za-z0-9_-] for attachmentDisplayName to strip
// the prefix back off: the web passes nanoid(6), the app passes a slice of a random uuid.
export function uniqueAttachmentName(fileName: string, token: string): string {
    return `${Date.now().toString(36)}-${token}-${fileName}`
}

export function buildAttachmentsRef(paths: readonly string[]): string {
    return `[Attachments added to your workspace: ${paths.join(SEPARATOR)}]`
}

export function appendAttachmentsRef(text: string, ref: string): string {
    const trimmed = text.trim()
    return trimmed ? `${trimmed}\n\n${ref}` : ref
}

/** The message text without its attachments marker, for anything showing a preview (session titles). */
export function stripAttachmentsRef(text: string): string {
    return text.replace(BLOCK, '').trim()
}

export function parseAttachments(text: string): { text: string; paths: string[] } | null {
    const match = BLOCK.exec(text)
    if (!match) return null

    const paths = match[1]
        .split(SEPARATOR)
        .map(path => path.trim())
        .filter(Boolean)
    if (paths.length === 0) return null

    return { text: text.slice(0, match.index).trim(), paths }
}

export function attachmentDisplayName(path: string): string {
    const name = path.split('/').pop() ?? path
    return name.replace(UNIQUE_PREFIX, '') || name
}

import { CARD_MAX_FILES, DESKTOP_ATTACHMENT_MAX_BYTES, fileCardSchema, isDesktopAttachmentPath, type FileCard, type FileCardEntry } from '@rerun/contracts'

// A Mac result card points at one of this coworker's visible text files. The engine wrote these
// fields, but a saved tool result is still untrusted input to the renderer: accept only the small
// card shape and only paths the desktop read endpoint can open.
const hiddenSegment = (path: string) => path.split('/').some(segment => segment.startsWith('.'))
const validPath = (path: string) => isDesktopAttachmentPath(path) && !path.includes('\\') && !hiddenSegment(path)
const validName = (name: string) => name.length > 0 && name.length <= 255 && !/[\\/\p{Cc}]/u.test(name)

function candidate(value: unknown, depth = 0): unknown {
    if (depth > 2) return undefined
    if (typeof value === 'string') {
        try { return candidate(JSON.parse(value), depth + 1) }
        catch { return undefined }
    }
    if (value && typeof value === 'object' && !Array.isArray(value)) {
        const wrapper = value as { type?: unknown; value?: unknown }
        if (wrapper.type === 'json' && 'value' in wrapper) return candidate(wrapper.value, depth + 1)
        if (wrapper.type === 'text' && typeof wrapper.value === 'string') return candidate(wrapper.value, depth + 1)
    }
    return value
}

/**
 * Validate one recorded card_file result for the Mac conversation. It accepts the live tool output
 * (a JSON string), a stored text/json wrapper, a parsed card, and the legacy single-file card. Every
 * file must still look like a visible, singular .txt/.md reference of this coworker, with the
 * bounded size the card tool writes. Anything else returns undefined so the reply can fall back to
 * the real tool result instead of drawing a fabricated or partial card.
 */
export function desktopFileCardOf(value: unknown): FileCard | undefined {
    const parsed = fileCardSchema.safeParse(candidate(value))
    if (!parsed.success) return undefined
    const { files } = parsed.data
    if (files.length < 1 || files.length > CARD_MAX_FILES) return undefined
    const normalized: FileCardEntry[] = []
    for (const file of files) {
        if (file.scope !== 'agent') return undefined
        if (!validPath(file.path)) return undefined
        if (!validName(file.name) || file.name !== file.path.split('/').at(-1)) return undefined
        if (!Number.isSafeInteger(file.size) || file.size < 0 || file.size > DESKTOP_ATTACHMENT_MAX_BYTES) return undefined
        normalized.push({ path: file.path, name: file.name, size: file.size, scope: 'agent' })
    }
    return { kind: 'file', files: normalized }
}

/** Read a card's text through the authenticated desktop Files route, at the moment it is opened. */
export async function readDesktopCardFile(agentId: string, path: string): Promise<{ content: string; truncated: boolean }> {
    const query = new URLSearchParams({ path })
    const response = await fetch(`/api/desktop/agents/${encodeURIComponent(agentId)}/files/read?${query.toString()}`, { cache: 'no-store' })
    const body = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(typeof body?.error === 'string' ? body.error : 'This file is no longer available.')
    if (typeof body?.content !== 'string') throw new Error('This file is no longer available.')
    return { content: body.content, truncated: body.truncated === true }
}

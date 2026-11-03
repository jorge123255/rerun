export const MAX_DESKTOP_SOURCES = 32

export type DesktopSourcePart =
    | { type: 'source-url'; sourceId: string; url: string; title?: string }
    | { type: 'source-document'; sourceId: string; mediaType: string; title: string; filename?: string }

function label(value: unknown): string | undefined {
    return typeof value === 'string' ? value.trim().slice(0, 512) || undefined : undefined
}

// Keep the public AI SDK fields only. Provider metadata can contain private IDs or raw annotations.
export function desktopSourcePart(value: unknown): DesktopSourcePart | undefined {
    if (!value || typeof value !== 'object') return
    const source = value as Record<string, unknown>
    const sourceId = source.sourceId
    if (typeof sourceId !== 'string' || !sourceId.trim() || sourceId.length > 256) return
    const title = label(source.title)
    if (source.type === 'source-url') {
        if (typeof source.url !== 'string' || source.url.length > 4096 || !/^https:\/\//i.test(source.url)) return
        try {
            const url = new URL(source.url)
            if (url.username || url.password || url.protocol !== 'https:' || !url.hostname) return
            return { type: 'source-url', sourceId, url: url.href, ...(title && { title }) }
        } catch { return }
    }
    if (source.type === 'source-document') {
        const filename = label(source.filename)
        const documentTitle = title ?? filename
        if (!documentTitle || typeof source.mediaType !== 'string' || !source.mediaType.trim() || source.mediaType.length > 256) return
        return { type: 'source-document', sourceId, mediaType: source.mediaType, title: documentTitle, ...(filename && { filename }) }
    }
}

export function desktopSourceParts(parts: unknown): DesktopSourcePart[] {
    const sources: DesktopSourcePart[] = []
    if (!Array.isArray(parts)) return sources
    const seen = new Set<string>()
    for (const part of parts) {
        const source = desktopSourcePart(part)
        if (!source || seen.has(source.sourceId)) continue
        seen.add(source.sourceId)
        sources.push(source)
        if (sources.length === MAX_DESKTOP_SOURCES) break
    }
    return sources
}

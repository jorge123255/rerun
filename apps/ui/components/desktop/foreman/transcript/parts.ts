import { desktopForemanDocsResultSchema, isContextPart, toolLabelOf } from '@rerun/contracts'
import { selectDesktopHistoricalCard, type DesktopHistoricalCard } from '../../tool-presentations/select'
import { desktopHistoricalToolName, projectDesktopToolStatus, resolveDesktopHistoricalIdentity, type DesktopHistoricalToolSource } from '../../tool-presentations/status'
import { redactHistoricalText } from '../../tool-presentations/redact'
import type { DesktopHistoricalGenericItem } from '../../tool-presentations/plan'

export type ForemanHistoryPart =
    | { key: string; kind: 'text'; text: string }
    | { key: string; kind: 'reasoning'; text: string }
    | { key: string; kind: 'link'; url: string; title: string }
    | { key: string; kind: 'card'; card: DesktopHistoricalCard }
    | { key: string; kind: 'docs'; links: { url: string; title: string; text?: string }[]; note?: string }
    | { key: string; kind: 'tool'; item: DesktopHistoricalGenericItem }
    | { key: string; kind: 'unknown'; label: string }

export function safeForemanHistoryLink(raw: unknown): string | null {
    if (typeof raw !== 'string' || raw.length > 4096 || /[\u0000-\u0020\u007f]/.test(raw)) return null
    try {
        const url = new URL(raw)
        return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : null
    } catch { return null }
}

export function foremanHistoryParts(messageId: string, parts: readonly unknown[], answeredCalls?: ReadonlySet<string>): ForemanHistoryPart[] {
    return parts.flatMap((raw, index): ForemanHistoryPart[] => {
        if (isContextPart(raw)) return []
        const part = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {}
        const key = JSON.stringify([messageId, index, typeof part.toolCallId === 'string' ? part.toolCallId : typeof part.id === 'string' ? part.id : null])
        if (part.type === 'text' && typeof part.text === 'string') return [{ key, kind: 'text', text: part.text }]
        if (part.type === 'source-url') {
            const url = safeForemanHistoryLink(part.url)
            if (url) return [{ key, kind: 'link', url, title: typeof part.title === 'string' && part.title ? part.title : url }]
            return [{ key, kind: 'unknown', label: 'Saved link unavailable' }]
        }
        if (part.type === 'dynamic-tool' || typeof part.type === 'string' && part.type.startsWith('tool-')) {
            const tool: DesktopHistoricalToolSource = part
            const name = desktopHistoricalToolName(tool)
            if (part.state === 'output-available' && typeof part.toolCallId === 'string' && answeredCalls?.has(part.toolCallId)
                && (name === 'ask_user' || name === 'request_approval')) return []
            if (name === 'search_docs' && projectDesktopToolStatus(tool) === 'succeeded') {
                let output = part.output
                if (typeof output === 'string' && output.length <= 100000) { try { output = JSON.parse(output) } catch { output = null } }
                const parsed = desktopForemanDocsResultSchema.safeParse(output)
                if (parsed.success) {
                    const result = parsed.data
                    const entries = result.passages.length ? result.passages : result.pages?.length ? result.pages : [{ url: result.documentation, title: 'Rerun documentation' }]
                    const links = entries.flatMap(entry => { const url = safeForemanHistoryLink(entry.url); return url ? [{ url, title: entry.title, ...('text' in entry && typeof entry.text === 'string' ? { text: entry.text } : {}) }] : [] })
                    if (links.length) return [{ key, kind: 'docs', links, ...(result.note ? { note: result.note } : {}) }]
                }
            }
            const card = selectDesktopHistoricalCard(tool)
            if (card) return [{ key, kind: 'card', card }]
            const status = projectDesktopToolStatus(tool)
            const identity = resolveDesktopHistoricalIdentity(tool)
            return [{ key, kind: 'tool', item: { key, toolName: name, label: redactHistoricalText(toolLabelOf(name || 'tool'), 200), status: status === 'running' || status === 'pending' ? 'unknown' : status, detail: null, identity: identity.ok ? identity.identity : { ownerId: null, workspaceId: null, runId: null } } }]
        }
        if (part.type === 'reasoning' && typeof part.text === 'string') return [{ key, kind: 'reasoning', text: part.text }]
        return [{ key, kind: 'unknown', label: 'Saved content unavailable in this view' }]
    })
}

import { z } from 'zod'
import { stripBridgePrefix } from './chat-tool-name.js'

const MAX_TAKEOVER_CHARS = 32_768
export const desktopTakeoverGuardSchema = z.object({
    sourceMessageId: z.string().min(1).max(256),
    toolCallId: z.string().min(1).max(256),
    fingerprint: z.string().min(1).max(MAX_TAKEOVER_CHARS),
}).strict()
export type DesktopTakeoverGuard = z.infer<typeof desktopTakeoverGuardSchema>
export type DesktopTakeover = DesktopTakeoverGuard & { url: string; reason: string; requestedAt?: string | null }
type TakeoverRow = { id: string; role: string; contentJson: string; toolCallsJson?: string | null; createdAt?: string | null }
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
function json(value: unknown): unknown {
    if (typeof value !== 'string') return value
    try { return JSON.parse(value) } catch { return value }
}

export function desktopTakeoverInput(raw: unknown): { url: string; reason: string } | null {
    const input = record(json(raw))
    if (typeof input.url !== 'string' || input.url.length > 4096 || typeof input.reason !== 'string' || !input.reason.trim() || input.reason.length > 200) return null
    try {
        const url = new URL(input.url)
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null
    } catch { return null }
    return { url: input.url, reason: input.reason.trim() }
}

function delivered(raw: unknown, depth = 0): boolean {
    if (depth > 5) return false
    const value = record(json(raw))
    if (value.isError === true || value.type === 'error-text' || value.type === 'error-json') return false
    if (value.status === 'delivered') return true
    if ((value.type === 'json' || value.type === 'text') && 'value' in value) return delivered(value.value, depth + 1)
    if (value.structuredContent != null && delivered(value.structuredContent, depth + 1)) return true
    if (Array.isArray(value.content)) return value.content.some(part => record(part).type === 'text' && delivered(record(part).text, depth + 1))
    return false
}

// A later user turn or another non-skill tool invalidates the old request, including ask_user.
// Match a successful result to its nearest preceding call; prose after that call is allowed.
export function findDesktopTakeover(rows: readonly TakeoverRow[]): DesktopTakeover | null {
    let candidate: DesktopTakeover | null = null
    let acknowledged = false
    for (const row of rows) {
        if (row.role === 'user') { candidate = null; acknowledged = false; continue }
        const content = json(row.contentJson)
        const legacy = json(row.toolCallsJson)
        const parts = [...(Array.isArray(content) ? content : [content]), ...(Array.isArray(legacy) ? legacy : [])]
        for (const value of parts) {
            const part = record(value)
            const callId = part.toolCallId ?? part.id
            if (part.type === 'tool-result' || (row.role === 'tool' && (part.output !== undefined || part.result !== undefined))) {
                if (candidate && callId === candidate.toolCallId) acknowledged = part.isError !== true && delivered(part.output ?? part.result)
                continue
            }
            if (row.role !== 'assistant' || (part.type !== 'tool-call' && !part.toolName && !part.name && !record(part.function).name)) continue
            const rawName = part.toolName ?? part.name ?? record(part.function).name
            const name = typeof rawName === 'string' ? stripBridgePrefix(rawName) : ''
            if (name === 'skill_propose') continue
            candidate = null
            acknowledged = false
            if (name !== 'request_takeover' || typeof callId !== 'string' || !callId || callId.length > 256 || !row.id || row.id.length > 256) continue
            const input = desktopTakeoverInput(part.input ?? part.args ?? part.arguments ?? record(part.function).arguments)
            if (input) candidate = { sourceMessageId: row.id, toolCallId: callId, url: input.url, reason: input.reason, fingerprint: JSON.stringify(input), requestedAt: row.createdAt ?? null }
        }
    }
    return acknowledged ? candidate : null
}

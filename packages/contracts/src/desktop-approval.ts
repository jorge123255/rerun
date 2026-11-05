import { z } from 'zod'
import { pendingApprovals, type ApprovalItem } from './chat-hitl.js'
import { stripBridgePrefix } from './chat-tool-name.js'

const MAX_APPROVAL_CHARS = 32_768
export const desktopApprovalGuardSchema = z.object({
    sourceMessageId: z.string().min(1).max(256),
    toolCallId: z.string().min(1).max(256),
    fingerprint: z.string().min(1).max(MAX_APPROVAL_CHARS),
}).strict()
export type DesktopApprovalGuard = z.infer<typeof desktopApprovalGuardSchema>
export type DesktopApproval = DesktopApprovalGuard & { approvals: ApprovalItem[]; requestedAt?: string | null }
type ApprovalRow = { id: string; role: string; contentJson: string; toolCallsJson?: string | null; createdAt?: string | null }
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
function json(value: unknown): unknown {
    if (typeof value !== 'string') return value
    try { return JSON.parse(value) } catch { return value }
}

// Keep Rerun's original batch and legacy action/detail protocol. A displayed decision must refer
// to the complete action, so reject oversized input instead of truncating its meaning.
export function desktopApprovalInput(raw: unknown): { approvals: ApprovalItem[] } | null {
    const input = record(json(raw))
    const batch = json(input.approvals)
    const entries = Array.isArray(batch) ? batch : input.approvals === undefined && input.action !== undefined ? [input] : []
    if (!entries.length || entries.length > 20) return null
    for (const value of entries) {
        const item = record(value)
        if (typeof item.action !== 'string' || !item.action.trim() || item.action.length > 4000) return null
        if (item.detail != null && (typeof item.detail !== 'string' || item.detail.length > 8000)) return null
    }
    const approvals = pendingApprovals(input)
    if (JSON.stringify(approvals).length > MAX_APPROVAL_CHARS) return null
    return { approvals }
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
export function findDesktopApproval(rows: readonly ApprovalRow[]): DesktopApproval | null {
    let candidate: DesktopApproval | null = null
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
            if (name !== 'request_approval' || typeof callId !== 'string' || !callId || callId.length > 256 || !row.id || row.id.length > 256) continue
            const input = desktopApprovalInput(part.input ?? part.args ?? part.arguments ?? record(part.function).arguments)
            if (input) candidate = { sourceMessageId: row.id, toolCallId: callId, approvals: input.approvals, fingerprint: JSON.stringify(input.approvals), requestedAt: row.createdAt ?? null }
        }
    }
    return acknowledged ? candidate : null
}

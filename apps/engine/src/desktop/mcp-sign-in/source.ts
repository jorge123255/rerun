import { desktopMcpSignInAcknowledgement, parseDesktopMcpSignInInput, stripBridgePrefix, type DesktopMcpSignInGuard, type DesktopSecretRequestRow } from '@rerun/contracts'
import { listMessages } from '../../db/repos/messages.js'
import { getSystemDb } from '../../db/systemDb.js'
import { HttpError } from '../../lib/errors.js'
const record = (raw: unknown): Record<string, unknown> => raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {}
function json(raw: unknown): unknown { try { return typeof raw === 'string' ? JSON.parse(raw) : raw } catch { return null } }
export function findDesktopMcpSignInCall(rows: readonly DesktopSecretRequestRow[]) {
    let pending: { sourceMessageId: string; toolCallId: string; input: NonNullable<ReturnType<typeof parseDesktopMcpSignInInput>> } | null = null
    let server: ReturnType<typeof desktopMcpSignInAcknowledgement> = null
    for (const row of rows) {
        if (row.role === 'user') { pending = null; server = null; continue }
        const content = json(row.contentJson), legacy = json(row.toolCallsJson)
        for (const raw of [...(Array.isArray(content) ? content : [content]), ...(Array.isArray(legacy) ? legacy : [])]) {
            const part = record(raw), id = part.toolCallId ?? part.id
            if (part.type === 'tool-result' || row.role === 'tool' && (part.output !== undefined || part.result !== undefined)) {
                if (pending && id === pending.toolCallId) server = part.isError === true ? null : desktopMcpSignInAcknowledgement(part.output ?? part.result)
                continue
            }
            if (row.role !== 'assistant' || part.type !== 'tool-call' && !part.toolName && !part.name && !record(part.function).name) continue
            const name = part.toolName ?? part.name ?? record(part.function).name
            if (typeof name === 'string' && stripBridgePrefix(name) === 'skill_propose') continue
            pending = null; server = null
            if (typeof name !== 'string' || stripBridgePrefix(name) !== 'request_mcp_sign_in' || typeof id !== 'string' || !id || id.length > 256) continue
            const input = parseDesktopMcpSignInInput(part.input ?? part.args ?? part.arguments ?? record(part.function).arguments)
            if (input) pending = { sourceMessageId: row.id, toolCallId: id, input }
        }
    }
    return pending && server?.name === pending.input.name ? { ...pending, server, fingerprint: JSON.stringify([pending.input, server]) } : null
}
export async function readDesktopMcpSignInSource(agentId: string, sessionId: string, expected?: DesktopMcpSignInGuard) {
    let rows: DesktopSecretRequestRow[] = await listMessages(agentId, sessionId)
    if (expected) {
        const index = rows.findIndex(row => row.id === expected.sourceMessageId && row.role === 'assistant')
        if (index < 0) throw new HttpError(409, 'MCP sign-in source no longer exists.')
        const next = rows.findIndex((row, at) => at > index && row.role === 'user')
        rows = rows.slice(0, next < 0 ? undefined : next)
    }
    const found = findDesktopMcpSignInCall(rows)
    if (!found) return null
    const { client } = await getSystemDb(agentId)
    const rowsOfCall = await client.execute({ sql: `SELECT t.run_id,t.tool_name,t.input_json,t.result_json,t.is_error,r.status FROM tool_calls t JOIN runs r ON r.id=t.run_id AND r.agent_id=t.agent_id AND r.session_id=t.session_id WHERE t.agent_id=? AND t.session_id=? AND t.tool_call_id=? LIMIT 3`, args: [agentId, sessionId, found.toolCallId] })
    if (rowsOfCall.rows.length !== 1) throw new HttpError(409, 'MCP sign-in run is ambiguous.')
    const row = rowsOfCall.rows[0]
    if (stripBridgePrefix(String(row.tool_name)) !== 'request_mcp_sign_in' || Number(row.is_error) !== 0 || JSON.stringify(parseDesktopMcpSignInInput(row.input_json)) !== JSON.stringify(found.input) || JSON.stringify(desktopMcpSignInAcknowledgement(row.result_json)) !== JSON.stringify(found.server)) throw new HttpError(409, 'MCP sign-in acknowledgement changed.')
    const guard = { runId: String(row.run_id), sourceMessageId: found.sourceMessageId, toolCallId: found.toolCallId, fingerprint: found.fingerprint, server: found.server }
    if (expected && (guard.runId !== expected.runId || guard.sourceMessageId !== expected.sourceMessageId || guard.toolCallId !== expected.toolCallId || guard.fingerprint !== expected.fingerprint || JSON.stringify(guard.server) !== JSON.stringify(expected.server))) throw new HttpError(409, 'MCP sign-in source changed.')
    return { input: found.input, guard, status: String(row.status) }
}

import { withoutStoppedTriggerRequests } from '../triggers/human.js'
import { findDesktopSecretRequest, parseDesktopSecretToolInput, stripBridgePrefix, type DesktopSecretRequestGuard, type DesktopSecretRequestRow } from '@rerun/contracts'
import { listMessages } from '../../db/repos/messages.js'
import { getSystemDb } from '../../db/systemDb.js'
import { HttpError } from '../../lib/errors.js'

export async function readDesktopSecretSource(agentId: string, sessionId: string, expected?: DesktopSecretRequestGuard) {
    let rows: DesktopSecretRequestRow[] = expected ? await listMessages(agentId, sessionId) : await withoutStoppedTriggerRequests(agentId, sessionId, await listMessages(agentId, sessionId))
    if (expected) {
        const index = rows.findIndex(row => row.id === expected.sourceMessageId && row.role === 'assistant')
        if (index < 0) throw new HttpError(409, 'Credential request source no longer exists.')
        const nextUser = rows.findIndex((row, at) => at > index && row.role === 'user')
        rows = rows.slice(0, nextUser < 0 ? undefined : nextUser)
    }
    const pending = findDesktopSecretRequest(rows)
    if (!pending) return null
    const { client } = await getSystemDb(agentId)
    const result = await client.execute({ sql: `SELECT t.run_id,t.agent_id,t.session_id,t.tool_name,t.input_json,t.is_error,r.status
        FROM tool_calls t JOIN runs r ON r.id=t.run_id AND r.agent_id=t.agent_id AND r.session_id=t.session_id
        WHERE t.agent_id=? AND t.session_id=? AND t.tool_call_id=? LIMIT 3`, args: [agentId, sessionId, pending.toolCallId] })
    if (result.rows.length !== 1) throw new HttpError(409, 'Credential request run could not be identified.')
    const row = result.rows[0]
    if (stripBridgePrefix(String(row.tool_name)) !== 'request_secret' || Number(row.is_error) !== 0
        || JSON.stringify(parseDesktopSecretToolInput(row.input_json)) !== pending.fingerprint) throw new HttpError(409, 'Credential request run does not match its saved call.')
    const guard = { sourceMessageId: pending.sourceMessageId, toolCallId: pending.toolCallId, fingerprint: pending.fingerprint, runId: String(row.run_id) }
    if (expected && JSON.stringify(guard) !== JSON.stringify({ sourceMessageId: expected.sourceMessageId, toolCallId: expected.toolCallId, fingerprint: expected.fingerprint, runId: expected.runId })) throw new HttpError(409, 'Credential request source changed.')
    return { input: { fields: pending.fields, ...(pending.reason !== undefined ? { reason: pending.reason } : {}) }, guard, status: String(row.status), requestedAt: pending.requestedAt }
}

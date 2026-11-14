import { createHash } from 'node:crypto'
import { desktopApprovalInput, desktopQuestionInput, findDesktopApproval, findDesktopQuestion, FOREMAN_AGENT_ID, foremanQuestionGuardSchema, stripBridgePrefix } from '@rerun/contracts'
import { readAgentConfig } from '../../agents/loader.js'
import { hasDesktopToolGrant } from '../tool-grants.js'
import { listMessages } from '../../db/repos/messages.js'
import { getSystemDb } from '../../db/systemDb.js'
import { HttpError } from '../../lib/errors.js'

/** Match a saved request to one completed tool call from the managed turn. */
async function readRequestGuard(sessionId: string, userMessageId: string,
    request: { sourceMessageId: string; toolCallId: string; fingerprint: string }, name: 'ask_user' | 'request_approval') {
    const { client } = await getSystemDb(FOREMAN_AGENT_ID)
    const { rows } = await client.execute({
        sql: `SELECT call.run_id,call.tool_name,call.input_json,call.is_error,run.status
              FROM tool_calls call
              JOIN runs run ON run.id=call.run_id AND run.agent_id=call.agent_id AND run.session_id=call.session_id
              JOIN desktop_queued_turns receipt ON receipt.run_id=run.id
              WHERE call.agent_id=? AND call.session_id=? AND call.tool_call_id=? AND receipt.message_id=? LIMIT 2`,
        args: [FOREMAN_AGENT_ID, sessionId, request.toolCallId, userMessageId],
    })
    if (rows.length !== 1) throw new HttpError(409, 'The Foreman request could not be matched to its run.')
    const row = rows[0]!
    if (row.status !== 'done') return null
    const input = name === 'ask_user' ? desktopQuestionInput(row.input_json)?.questions : desktopApprovalInput(row.input_json)?.approvals
    if (row.is_error !== 0 || stripBridgePrefix(String(row.tool_name)) !== name || JSON.stringify(input) !== request.fingerprint) {
        throw new HttpError(409, 'The saved Foreman request does not match its tool call.')
    }
    return foremanQuestionGuardSchema.parse({
        runId: row.run_id, sourceMessageId: request.sourceMessageId, toolCallId: request.toolCallId,
        digest: createHash('sha256').update(request.fingerprint).digest('hex'),
    })
}

export async function readForemanQuestion(sessionId: string) {
    const messages = await listMessages(FOREMAN_AGENT_ID, sessionId)
    const user = messages.findLast(message => message.role === 'user')
    const question = findDesktopQuestion(messages)
    if (!user || !question) return null
    const guard = await readRequestGuard(sessionId, user.id, question, 'ask_user')
    return guard ? { guard, questions: question.questions } : null
}

export async function foremanApprovalEnabled() {
    const config = await readAgentConfig(FOREMAN_AGENT_ID)
    return config.kind === 'foreman' && config.enabled && hasDesktopToolGrant(config, 'requestApproval')
}

export async function readForemanApproval(sessionId: string) {
    if (!await foremanApprovalEnabled()) return null
    const messages = await listMessages(FOREMAN_AGENT_ID, sessionId)
    const user = messages.findLast(message => message.role === 'user')
    const approval = findDesktopApproval(messages)
    if (!user || !approval) return null
    const guard = await readRequestGuard(sessionId, user.id, approval, 'request_approval')
    return guard ? { guard, approvals: approval.approvals } : null
}

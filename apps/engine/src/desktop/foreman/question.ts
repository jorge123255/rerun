import { createHash } from 'node:crypto'
import { desktopQuestionInput, findDesktopQuestion, FOREMAN_AGENT_ID, foremanQuestionGuardSchema, stripBridgePrefix } from '@rerun/contracts'
import { listMessages } from '../../db/repos/messages.js'
import { getSystemDb } from '../../db/systemDb.js'
import { HttpError } from '../../lib/errors.js'

/** Match the saved question to a single completed, managed Foreman tool call. */
export async function readForemanQuestion(sessionId: string) {
    const messages = await listMessages(FOREMAN_AGENT_ID, sessionId)
    const question = findDesktopQuestion(messages)
    const userMessage = messages.findLast(message => message.role === 'user')
    if (!question || !userMessage) return null
    const { client } = await getSystemDb(FOREMAN_AGENT_ID)
    const { rows } = await client.execute({
        sql: `SELECT call.run_id,call.tool_name,call.input_json,call.is_error,run.status
              FROM tool_calls call
              JOIN runs run ON run.id=call.run_id AND run.agent_id=call.agent_id AND run.session_id=call.session_id
              JOIN desktop_queued_turns receipt ON receipt.run_id=run.id
              WHERE call.agent_id=? AND call.session_id=? AND call.tool_call_id=? AND receipt.message_id=? LIMIT 2`,
        args: [FOREMAN_AGENT_ID, sessionId, question.toolCallId, userMessage.id],
    })
    if (rows.length !== 1) throw new HttpError(409, 'The Foreman question could not be matched to its run.')
    const row = rows[0]!
    if (row.status !== 'done') return null
    if (row.is_error !== 0 || stripBridgePrefix(String(row.tool_name)) !== 'ask_user'
        || JSON.stringify(desktopQuestionInput(row.input_json)?.questions) !== question.fingerprint) {
        throw new HttpError(409, 'The saved Foreman question does not match its tool call.')
    }
    const guard = foremanQuestionGuardSchema.parse({
        runId: row.run_id, sourceMessageId: question.sourceMessageId, toolCallId: question.toolCallId,
        digest: createHash('sha256').update(question.fingerprint).digest('hex'),
    })
    return { guard, questions: question.questions }
}

import 'server-only'
import type { Client } from '@libsql/client'
import { desktopQuestionGuardSchema, desktopApprovalGuardSchema, desktopTakeoverGuardSchema, desktopServiceRequestGuardSchema } from '@rerun/contracts'
import { chat } from '@/lib/engine/client'
import type { DesktopRuntime } from '../runtime'
import { engineOf } from '../settings'
import type { TriggerRequestReceipt } from '../../trigger-requests/types'
import type { TriggerRequestRootBindings } from './canonical'
import type { TriggerRequestRecord } from './journal'

export async function probeCanonicalTriggerAdmission(runtime: DesktopRuntime, db: Client, root: TriggerRequestRootBindings, record: TriggerRequestRecord): Promise<TriggerRequestReceipt> {
    const link = record.link
    if (link.kind === 'secret') return root.secret?.probe ? root.secret.probe(record, AbortSignal.timeout(10_000)) : { status: 'unknown' }
    if (link.kind === 'signin') return { status: 'unknown' }
    try {
        const tables = {
            question: { table: 'desktop_question_answers', id: 'question_id', guard: 'question_guard', text: 'answer_text' },
            approval: { table: 'desktop_approval_answers', id: 'approval_id', guard: 'approval_guard', text: 'answer_text' },
            takeover: { table: 'desktop_takeover_answers', id: 'takeover_id', guard: 'takeover_guard', text: 'answer_text' },
            service: { table: 'desktop_service_suggestion_receipts', id: 'service_request_id', guard: null, text: 'summary_text' },
        } as const
        const spec = tables[link.kind]
        const sql = link.kind === 'service'
            ? `SELECT r.request_id,r.summary_text AS answer_text,s.source_message_id,s.tool_call_id,s.fingerprint FROM desktop_service_suggestion_receipts r JOIN desktop_service_suggestion_requests s ON s.service_request_id=r.service_request_id WHERE s.agent_id=? AND s.session_id=? AND r.service_request_id=?`
            : `SELECT request_id,${spec.text} AS answer_text,${spec.guard} AS source_guard FROM ${spec.table} WHERE agent_id=? AND session_id=? AND ${spec.id}=?`
        const row = (await db.execute({ sql, args: [link.agentId, link.sessionId, link.requestId] })).rows[0]
        if (!row) return { status: 'absent' }
        const guard = link.kind === 'service' ? desktopServiceRequestGuardSchema.parse({ sourceMessageId: row.source_message_id, toolCallId: row.tool_call_id, fingerprint: row.fingerprint }) : JSON.parse(String(row.source_guard))
        const typed = link.kind === 'question' ? { question: desktopQuestionGuardSchema.parse(guard) }
            : link.kind === 'approval' ? { approval: desktopApprovalGuardSchema.parse(guard) }
            : link.kind === 'takeover' ? { takeover: desktopTakeoverGuardSchema.parse(guard) }
            : { service: desktopServiceRequestGuardSchema.parse(guard) }
        if (guard.sourceMessageId !== link.sourceMessageId || guard.toolCallId !== link.toolCallId) return { status: 'unknown' }
        const response = await chat(engineOf(runtime), link.engineAgentId, { sessionId: link.engineSessionId, message: String(row.answer_text), source: 'dashboard',
            desktopQueuedTurn: { runId: String(row.request_id), replayOnly: true, ...typed } })
        try {
            if (response.status === 404 && (await response.clone().json().catch(() => null))?.code === 'queued_turn_not_found') return { status: 'reserved' }
            if (response.ok && response.headers.get('x-session-id') === link.engineSessionId && response.headers.get('x-run-id') === String(row.request_id)) return { status: 'accepted', continuationId: String(row.request_id) }
            return { status: 'unknown' }
        } finally { void response.body?.cancel().catch(() => {}) }
    } catch { return { status: 'unknown' } }
}

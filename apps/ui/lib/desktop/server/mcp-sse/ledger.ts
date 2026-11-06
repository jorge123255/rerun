import 'server-only'
import type { Client } from '@libsql/client'
import { desktopMcpSseOutcomeSchema } from '@rerun/contracts'
import type { SseCallLedger } from './types'
import { SseFailure, wait } from './errors'

export function sqliteSseCallLedger(db: Client): SseCallLedger {
    return {
        async claim(call, fingerprint, signal) {
            signal.throwIfAborted()
            const result = await wait(db.execute({
                sql: 'INSERT INTO desktop_mcp_sse_calls(request_id,owner,server_id,session_id,run_id,call_id,fingerprint) VALUES(?,?,?,?,?,?,?) ON CONFLICT DO NOTHING',
                args: [call.requestId, call.agentId, call.serverId, call.sessionId, call.runId, call.toolCallId, fingerprint],
            }), signal)
            signal.throwIfAborted()
            if (result.rowsAffected === 1) return 'new'
            const row = (await wait(db.execute({ sql: 'SELECT * FROM desktop_mcp_sse_calls WHERE request_id=?', args: [call.requestId] }), signal)).rows[0]
            if (!row || row.owner !== call.agentId || row.server_id !== call.serverId || row.session_id !== call.sessionId || row.run_id !== call.runId || row.call_id !== call.toolCallId || row.fingerprint !== fingerprint) throw new SseFailure('changed')
            return 'existing'
        },
        async settle(call, fingerprint, outcome) {
            const checked = desktopMcpSseOutcomeSchema.parse(outcome)
            if (checked.requestId !== call.requestId) throw new SseFailure('changed')
            const encoded = JSON.stringify(checked)
            if (Buffer.byteLength(encoded) > 1_100_000) throw new SseFailure('invalid-data')
            const result = await db.execute({
                sql: 'UPDATE desktop_mcp_sse_calls SET outcome=? WHERE request_id=? AND owner=? AND server_id=? AND session_id=? AND run_id=? AND call_id=? AND fingerprint=? AND outcome IS NULL',
                args: [encoded, call.requestId, call.agentId, call.serverId, call.sessionId, call.runId, call.toolCallId, fingerprint],
            })
            if (result.rowsAffected !== 1) {
                const row = (await db.execute({ sql: 'SELECT outcome FROM desktop_mcp_sse_calls WHERE request_id=? AND fingerprint=?', args: [call.requestId, fingerprint] })).rows[0]
                if (row?.outcome !== encoded) throw new SseFailure('changed')
            }
        },
    }
}

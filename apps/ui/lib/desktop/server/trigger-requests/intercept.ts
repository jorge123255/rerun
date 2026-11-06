import 'server-only'
import type { Client } from '@libsql/client'
import { DesktopHttpError } from '../auth'
import { canonicalRequestId, triggerRequestDecisionSchema, type TriggerRequestDecision } from '../../trigger-requests/types'
import type { DesktopTriggerRequests } from './runtime'

export async function interceptCanonicalTriggerDecision(db: Client, service: DesktopTriggerRequests, sessionId: string, raw: TriggerRequestDecision): Promise<Response | null> {
    const decision = triggerRequestDecisionSchema.parse(raw)
    const webhook = await service.captureForSession(sessionId)
    const rows = await db.execute({ sql: `SELECT link_key FROM desktop_trigger_request_links_v1 WHERE session_id=? AND json_extract(source_json,'$.requestId')=? AND json_extract(source_json,'$.kind')=? LIMIT 2`, args: [sessionId, canonicalRequestId(decision), decision.kind] })
    if (!rows.rows.length) {
        if (webhook) throw new DesktopHttpError(409, 'This webhook request is no longer current or its source could not be linked')
        return null
    }
    if (rows.rows.length !== 1) throw new DesktopHttpError(409, 'Ambiguous webhook request linkage')
    const response = await service.lifecycle.decide(String(rows.rows[0].link_key), decision)
    // Existing service clients distinguish their transport attempt from the canonical queued turn.
    if (decision.kind === 'service') response.headers.set('x-service-request-attempt-id', decision.input.requestId)
    return response
}

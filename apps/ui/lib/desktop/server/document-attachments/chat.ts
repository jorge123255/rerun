import 'server-only'
import type { Client } from '@libsql/client'
import type { DesktopDocumentSendSelection, DesktopResolvedDocument } from '@rerun/contracts'
import { DesktopHttpError } from '../auth'
import type { DesktopRuntime } from '../runtime'
import { resolveDesktopDocumentAdmission } from './binding'
export async function admitDesktopChatDocuments(runtime: DesktopRuntime, db: Client, input: {
    agentId: string; sessionId?: string; tabUid?: string; documents: DesktopDocumentSendSelection
}) {
    const { documents } = input, scope = documents.scope
    if (scope.agentId !== input.agentId) throw new DesktopHttpError(409, 'These documents belong to another coworker.')
    if (input.sessionId) {
        const session = scope.sessionId ?? String((await db.execute({ sql: 'SELECT s.id FROM desktop_tab_starts t JOIN desktop_sessions s ON s.engine_session_id=t.engine_session_id AND s.agent_id=t.agent_id WHERE t.agent_id=? AND t.uid=?', args: [input.agentId, scope.tabUid] })).rows[0]?.id ?? '')
        if (session !== input.sessionId) throw new DesktopHttpError(409, 'These documents belong to another conversation.')
    } else if (scope.sessionId || scope.tabUid !== input.tabUid) throw new DesktopHttpError(409, 'These documents belong to another new conversation.')
    const admission = await resolveDesktopDocumentAdmission(runtime, input.agentId, documents, AbortSignal.timeout(20_000))
    const resolved: DesktopResolvedDocument[] = admission.references.map((reference, index) => {
        const content = admission.inputs[index]
        if (!content || content.mode !== 'text') throw new DesktopHttpError(409, 'Prepare this document before sending.')
        return { reference, text: content.text }
    })
    if (resolved.length !== documents.attachmentIds.length || resolved.some((item, index) => item.reference.attachmentId !== documents.attachmentIds[index])) throw new DesktopHttpError(409, 'The document selection changed.')
    return resolved
}

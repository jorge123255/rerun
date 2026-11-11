import 'server-only'
import type { Client } from '@libsql/client'
import { desktopResolvedDocumentSchema, type DesktopDocumentSendSelection, type DesktopResolvedDocument } from '@rerun/contracts'
import { DesktopHttpError } from '../auth'
import type { DesktopRuntime } from '../runtime'
import { desktopDocumentAttachmentService, resolveDesktopDocumentAdmission } from './binding'
export async function admitDesktopChatDocuments(runtime: DesktopRuntime, db: Client, input: {
    agentId: string; sessionId?: string; tabUid?: string; documents: DesktopDocumentSendSelection
}) {
    const { documents } = input, scope = documents.scope
    if (scope.agentId !== input.agentId) throw new DesktopHttpError(409, 'These documents belong to another coworker.')
    if (input.sessionId) {
        const session = scope.sessionId ?? String((await db.execute({ sql: 'SELECT s.id FROM desktop_tab_starts t JOIN desktop_sessions s ON s.engine_session_id=t.engine_session_id AND s.agent_id=t.agent_id WHERE t.agent_id=? AND t.uid=?', args: [input.agentId, scope.tabUid] })).rows[0]?.id ?? '')
        if (session !== input.sessionId) throw new DesktopHttpError(409, 'These documents belong to another conversation.')
    } else if (scope.sessionId || scope.tabUid !== input.tabUid) throw new DesktopHttpError(409, 'These documents belong to another new conversation.')
    const signal = AbortSignal.timeout(20_000)
    const admission = await resolveDesktopDocumentAdmission(runtime, input.agentId, documents, signal)
    const resolved: DesktopResolvedDocument[] = []
    for (const [index, reference] of admission.references.entries()) {
        const content = admission.inputs[index]
        if (content?.mode === 'text') {
            resolved.push({ reference, text: content.text })
        } else if (content?.mode === 'file' && reference.kind === 'image') {
            const service = await desktopDocumentAttachmentService(runtime)
            const { bytes, renderedImage } = await service.read(reference.scope, reference.attachmentId, reference.sha256, signal, 'preview')
            const image = desktopResolvedDocumentSchema.safeParse({ reference, dataBase64: Buffer.from(bytes).toString('base64'),
                ...(renderedImage && { renderedImage }) })
            if (!image.success) throw new DesktopHttpError(409, 'The selected image is no longer available.')
            resolved.push(image.data)
        } else throw new DesktopHttpError(409, 'Prepare this document before sending.')
    }
    if (resolved.length !== documents.attachmentIds.length || resolved.some((item, index) => item.reference.attachmentId !== documents.attachmentIds[index])) throw new DesktopHttpError(409, 'The document selection changed.')
    return resolved
}

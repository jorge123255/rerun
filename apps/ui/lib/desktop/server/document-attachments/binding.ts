import 'server-only'
import { createHash } from 'node:crypto'
import type { DesktopDocumentSendSelection } from '@rerun/contracts'
import type { DesktopRuntime } from '../runtime'
import { openDesktopDatabase } from '../database'
import { DesktopHttpError } from '../auth'
import { createDesktopDocumentRuntime } from './runtime'
import type { DesktopDocumentAttachmentService } from './service'

const state = globalThis as typeof globalThis & { desktopDocumentBinding?: { identity: string; service: Promise<DesktopDocumentAttachmentService> } }
export function desktopDocumentAttachmentService(runtime: DesktopRuntime): Promise<DesktopDocumentAttachmentService> {
    const identity = createHash('sha256').update(JSON.stringify([runtime.dataRoot, runtime.workspaceId, runtime.launchNonce, runtime.engine, runtime.app])).digest('hex')
    if (state.desktopDocumentBinding?.identity === identity) return state.desktopDocumentBinding.service
    const service = openDesktopDatabase(runtime.dataRoot).then(db => createDesktopDocumentRuntime(runtime, db, { isCurrent: () => state.desktopDocumentBinding?.identity === identity }))
    state.desktopDocumentBinding = { identity, service }
    void service.catch(() => { if (state.desktopDocumentBinding?.identity === identity) delete state.desktopDocumentBinding })
    return service
}
/** Server send/queue authority calls this with the selected manifest, never renderer text. */
export async function resolveDesktopDocumentAdmission(runtime: DesktopRuntime, agentId: string, input: DesktopDocumentSendSelection, signal: AbortSignal) {
    if (input.scope.agentId !== agentId) throw new DesktopHttpError(409, 'These attachments belong to another coworker.')
    const { scope, ...selection } = input
    const result = await (await desktopDocumentAttachmentService(runtime)).admission(scope, selection, signal)
    if (!result.allowed) throw new DesktopHttpError(409, result.reason ?? 'Prepare the selected attachments before sending.')
    return result
}
export async function consumeDesktopDocumentAdmission(runtime: DesktopRuntime, input: DesktopDocumentSendSelection, signal: AbortSignal) {
    await (await desktopDocumentAttachmentService(runtime)).consume(input.scope, input.admissionId, signal)
}

import 'server-only'
import { createHash } from 'node:crypto'
import { FOREMAN_AGENT_ID, type DesktopDocumentSendSelection } from '@rerun/contracts'
import type { DesktopRuntime } from '../runtime'
import { openDesktopDatabase } from '../database'
import { DesktopHttpError } from '../auth'
import { createDesktopDocumentRuntime } from './runtime'
import type { DesktopDocumentAttachmentService } from './service'

type Binding = { identity: string; services: Partial<Record<'coworker' | 'foreman', Promise<DesktopDocumentAttachmentService>>> }
const state = globalThis as typeof globalThis & { desktopDocumentBinding?: Binding }
export function desktopDocumentAttachmentService(runtime: DesktopRuntime, kind: 'coworker' | 'foreman' = 'coworker'): Promise<DesktopDocumentAttachmentService> {
    const identity = createHash('sha256').update(JSON.stringify([runtime.dataRoot, runtime.workspaceId, runtime.launchNonce, runtime.engine, runtime.app])).digest('hex')
    if (state.desktopDocumentBinding?.identity !== identity) state.desktopDocumentBinding = { identity, services: {} }
    const binding = state.desktopDocumentBinding
    if (binding.services[kind]) return binding.services[kind]
    const service = openDesktopDatabase(runtime.dataRoot).then(db => createDesktopDocumentRuntime(runtime, db, { isCurrent: () => state.desktopDocumentBinding === binding }, kind))
    binding.services[kind] = service
    void service.catch(() => { if (binding.services[kind] === service) delete binding.services[kind] })
    return service
}
/** Server send/queue authority calls this with the selected manifest, never renderer text. */
export async function resolveDesktopDocumentAdmission(runtime: DesktopRuntime, agentId: string, input: DesktopDocumentSendSelection, signal: AbortSignal) {
    if (input.scope.agentId !== agentId) throw new DesktopHttpError(409, 'These attachments belong to another coworker.')
    const { scope, ...selection } = input
    const result = await (await desktopDocumentAttachmentService(runtime, agentId === FOREMAN_AGENT_ID ? 'foreman' : 'coworker')).admission(scope, selection, signal)
    if (!result.allowed) throw new DesktopHttpError(409, result.reason ?? 'Prepare the selected attachments before sending.')
    return result
}
export async function consumeDesktopDocumentAdmission(runtime: DesktopRuntime, input: DesktopDocumentSendSelection, signal: AbortSignal) {
    await (await desktopDocumentAttachmentService(runtime, input.scope.agentId === FOREMAN_AGENT_ID ? 'foreman' : 'coworker')).consume(input.scope, input.admissionId, signal)
}

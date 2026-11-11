import 'server-only'
import { desktopMcpSignInSourceSchema, type DesktopMcpSignInSource } from '../../../../../../packages/contracts/src/desktop-mcp-sign-in'
import { sourceScope } from '../mcp-device-approval/model'
import type { DeviceReviewStore } from '../mcp-device-approval/store'
import type { createDesktopMcpBrowserApprovals } from '../mcp-sign-in/browser-approval'
import type { DesktopMcpSignInStore } from '../mcp-sign-in/store'
import type { ApprovedSignInMethod, SignInMethodAdmissionPorts } from './contract'
import { hasExactMcpSignInOwner, type McpSignInOwner } from './owner'

type CurrentOwner = McpSignInOwner & { signal: AbortSignal; check(): void }
type Ports = {
    workspaceId: string
    browser: (owner: McpSignInOwner) => ReturnType<typeof createDesktopMcpBrowserApprovals>
    requests: Pick<DesktopMcpSignInStore, 'readBySource'>
    devices: Pick<DeviceReviewStore, 'bySource'>
    /** The caller supplies live source and grant authority. Read-only inside the selector transaction. */
    owner(source: DesktopMcpSignInSource, signal: AbortSignal): Promise<CurrentOwner>
    now?: () => number
}

/** The selector reads actual human decisions under its own SQLite transaction. */
export function readApprovedMcpSignInMethod(ports: Ports): SignInMethodAdmissionPorts['approved'] {
    const now = ports.now ?? Date.now
    return async (input, query, stop) => {
        stop.throwIfAborted()
        const owner = await ports.owner(input.source, stop)
        const signal = AbortSignal.any([owner.signal, stop])
        const check = () => { signal.throwIfAborted(); owner.check() }
        check()
        if (owner.workspaceId !== ports.workspaceId || owner.owner !== input.source.agentId || owner.sessionId !== input.source.sessionId) return null
        const request = await ports.requests.readBySource(input.source, query)
        if (!request || request.receipt) return null
        let value: ApprovedSignInMethod
        if (input.method === 'browser') {
            const record = await ports.browser(owner).read({ requestId: request.requestId, attemptId: input.approvalId, source: request.source }, query)
            if (!record) return null
            value = record.approval
        } else {
            if (!await hasExactMcpSignInOwner(query, owner)) return null
            const saved = await ports.devices.bySource(ports.workspaceId, owner.owner, sourceScope(ports.workspaceId, request.source), query)
            if (!saved || saved.value.state !== 'approved' || saved.value.decision?.operation !== 'approve-device-method'
                || JSON.stringify(saved.value.source) !== JSON.stringify(desktopMcpSignInSourceSchema.parse(request.source))) return null
            const approval = saved.value.approval
            if (approval.approvalId !== input.approvalId || approval.engineAgentId !== owner.engineAgentId
                || approval.sessionId !== owner.engineSessionId || approval.approvedUntil <= now()) return null
            value = {
                workspaceId: owner.workspaceId, owner: owner.owner, engineAgentId: owner.engineAgentId, engineSessionId: owner.engineSessionId,
                registrationId: approval.registrationId, revision: approval.revision, name: approval.name, resource: approval.method.resource,
                requestId: request.requestId, approvalId: approval.approvalId, method: 'device',
                credentialGeneration: approval.credentialGeneration, expiresAt: approval.approvedUntil,
            }
        }
        check()
        return { value, signal, check }
    }
}

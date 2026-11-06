import { desktopGuestShellResultSchema, type DesktopGuestShellIdentity, type DesktopGuestShellRequest, type DesktopGuestShellResult } from '@rerun/contracts'
import type { DesktopGuestShellTransport } from './types.js'
export type DesktopGuestShellRpc = (identity: DesktopGuestShellIdentity, body: Record<string, unknown>, signal: AbortSignal) => Promise<Record<string, unknown>>
const commandId = (identity: DesktopGuestShellIdentity) => identity.requestId.replaceAll('-', '')
/** RPC envelopes get fresh identities in the native screen service; commandId is immutable. */
export function createDesktopGuestShellTransport(rpc: DesktopGuestShellRpc): DesktopGuestShellTransport {
    function decode(raw: Record<string, unknown>, identity: DesktopGuestShellIdentity): DesktopGuestShellResult {
        const { ok, requestId, ...body } = raw
        if (ok !== true || requestId !== commandId(identity)) throw new Error('Guest command acknowledgement changed.')
        return desktopGuestShellResultSchema.parse({ ...body, requestId: identity.requestId })
    }
    return {
        async execute(identity: DesktopGuestShellRequest, signal) {
            return decode(await rpc(identity, { op: 'guest-shell', commandId: commandId(identity), fingerprint: identity.fingerprint, workspaceFingerprint: identity.guest.workspaceFingerprint, command: identity.command, timeoutMs: identity.timeoutMs, cwd: identity.cwd, ...(identity.expectedPackageEvidence ? { expectedPackageEvidence: identity.expectedPackageEvidence } : {}) }, signal), identity)
        },
        async inspect(identity, signal) { return decode(await rpc(identity, { op: 'guest-shell-inspect', commandId: commandId(identity), workspaceFingerprint: identity.guest.workspaceFingerprint }, signal), identity) },
        async cancel(identity, signal) {
            const result = await rpc(identity, { op: 'guest-shell-cancel', commandId: commandId(identity), workspaceFingerprint: identity.guest.workspaceFingerprint }, signal)
            if (result.ok !== true || result.requestId !== commandId(identity) || result.drained !== true) throw new Error('Guest command cancellation was not acknowledged.')
            const { drained: _drained, ...saved } = result
            const outcome = decode(saved, identity)
            if (outcome.status === 'interrupted' || outcome.status === 'unavailable') throw new Error('Guest command outcome is unconfirmed.')
            return outcome
        },
    }
}

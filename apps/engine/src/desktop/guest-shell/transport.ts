import { desktopGuestShellResultSchema } from '@rerun/contracts'
import { decodeFrame, encodeFrame } from '../isolated-screen/frame.js'
import { containerName } from '../isolated-screen/identity.js'
import type { DockerClient } from '../isolated-screen/docker-cli.js'
import type { DesktopGuestShellIdentity, DesktopGuestShellRequest, DesktopGuestShellResult } from './types.js'

function requestHex(requestId: string): string {
    return requestId.replaceAll('-', '')
}

function reason(value: unknown): string {
    if (typeof value !== 'string' || !value || value.length > 200 || /[^\x20-\x7e]/.test(value)) return 'The guest command failed.'
    if (value.includes('://') || value.includes('/Users') || value.includes('docker.sock') || value.includes('\\')) return 'The guest command failed.'
    return value
}

function decode(blob: Buffer, requestId: string): DesktopGuestShellResult {
    const { value } = decodeFrame(blob)
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('The guest returned an invalid command result.')
    const record = value as Record<string, unknown>
    if (record.ok !== true) throw new Error(reason(record.reason))
    return desktopGuestShellResultSchema.parse({ ...record, requestId })
}

export function createDesktopGuestShellTransport(docker: DockerClient) {
    return {
        async execute(identity: DesktopGuestShellRequest, signal: AbortSignal): Promise<DesktopGuestShellResult> {
            const blob = await docker.exec(containerName(identity.guest.engineAgentId), ['rerun-rpc'], encodeFrame({
                op: 'guest-shell',
                requestId: requestHex(identity.requestId),
                command: identity.command,
                timeoutMs: identity.timeoutMs,
                cwd: identity.cwd,
                ...(identity.packages ? { packages: identity.packages } : {}),
            }), signal)
            return decode(blob, identity.requestId)
        },
        async inspect(identity: DesktopGuestShellIdentity, signal: AbortSignal): Promise<DesktopGuestShellResult> {
            const blob = await docker.exec(containerName(identity.guest.engineAgentId), ['rerun-rpc'], encodeFrame({ op: 'guest-shell-inspect', requestId: requestHex(identity.requestId) }), signal)
            return decode(blob, identity.requestId)
        },
        async cancel(identity: DesktopGuestShellIdentity, signal: AbortSignal): Promise<void> {
            const { value } = decodeFrame(await docker.exec(containerName(identity.guest.engineAgentId), ['rerun-rpc'], encodeFrame({ op: 'cancel', requestId: requestHex(identity.requestId) }), signal)
            if (!value || typeof value !== 'object' || Array.isArray(value) || (value as Record<string, unknown>).ok !== true) throw new Error('Guest command cancellation was not acknowledged.')
        },
    }
}

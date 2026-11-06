import type { DesktopRemoteActor, DesktopRemoteIdentity, DesktopRemoteSnapshot } from '@rerun/contracts'
import {
    REMOTE_GATEWAY_APPROVED_READS,
    remoteGatewayAdmissionSchema,
    remoteGatewayCapabilitySchema,
    remoteGatewayGrantSchema,
    type RemoteGatewayAdmission,
    type RemoteGatewayGrant,
} from './contract.js'

export type RemoteGatewaySnapshotPort = {
    read(actor: DesktopRemoteActor, signal: AbortSignal): Promise<DesktopRemoteSnapshot | null>
}

export type RemoteGatewayAdmissionInput = {
    enabled: boolean
    capabilityApproved: boolean
    actor: DesktopRemoteActor
    grant: RemoteGatewayGrant | null
    now: string
}

const closed = (outcome: RemoteGatewayAdmission['outcome']): RemoteGatewayAdmission =>
    remoteGatewayAdmissionSchema.parse({ outcome, connected: false, grantsTools: false })

function sameMachine(actor: DesktopRemoteActor, identity: DesktopRemoteIdentity, snapshot: DesktopRemoteSnapshot): boolean {
    const connection = snapshot.connection
    if (!connection) return false
    return actor.installId === snapshot.actor.installId
        && actor.workspaceId === snapshot.actor.workspaceId
        && actor.workspaceId === connection.workspaceId
        && actor.workspaceId === connection.identity.workspaceId
        && identity.protocolVersion === 1
        && identity.machineId === connection.identity.machineId
        && identity.workspaceId === connection.identity.workspaceId
        && connection.identity.protocolVersion === 1
}

export function createRemoteGatewayAdmission(port: RemoteGatewaySnapshotPort) {
    return {
        async admit(input: RemoteGatewayAdmissionInput, signal: AbortSignal): Promise<RemoteGatewayAdmission> {
            if (signal.aborted) return closed('uncertain')
            if (input.enabled !== true) return closed('disabled')
            const capability = remoteGatewayCapabilitySchema.safeParse({ approvedReads: REMOTE_GATEWAY_APPROVED_READS })
            if (!input.capabilityApproved || !capability.success) return closed('unavailable')
            const grant = input.grant ? remoteGatewayGrantSchema.safeParse(input.grant) : null
            if (!grant?.success) return closed('unavailable')
            if (grant.data.revoked) return closed('revoked')
            if (Date.parse(input.now) >= Date.parse(grant.data.expiresAt)) return closed('expired')
            if (grant.data.actor.installId !== input.actor.installId || grant.data.actor.workspaceId !== input.actor.workspaceId) return closed('unavailable')
            if (grant.data.identity.workspaceId !== input.actor.workspaceId) return closed('unavailable')
            let snapshot: DesktopRemoteSnapshot | null
            try {
                snapshot = await port.read(input.actor, signal)
            } catch {
                return closed('uncertain')
            }
            if (signal.aborted) return closed('uncertain')
            if (!snapshot || !snapshot.connection || !snapshot.selected || snapshot.runtimeState !== 'connected' || snapshot.connection.health.state !== 'connected') {
                return closed('no-host')
            }
            if (!sameMachine(input.actor, grant.data.identity, snapshot)) return closed('unavailable')
            return remoteGatewayAdmissionSchema.parse({
                outcome: 'admitted',
                connected: false,
                grantsTools: false,
                workspaceId: input.actor.workspaceId,
                machineId: grant.data.identity.machineId,
            })
        },
        revoke(grant: RemoteGatewayGrant): RemoteGatewayGrant {
            return remoteGatewayGrantSchema.parse({ ...grant, revoked: true })
        },
    }
}

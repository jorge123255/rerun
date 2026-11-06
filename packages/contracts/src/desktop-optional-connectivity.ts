import { z } from 'zod'
import { desktopRemoteActorSchema, desktopRemoteIdentitySchema } from './desktop-remote-machines.js'
import { desktopWorkspaceIdSchema } from './desktop-workspaces.js'

/** Disabled unless a caller passes an explicit enabled flag. Environment variables are not a switch. */
export const optionalConnectivitySwitchSchema = z.strictObject({ enabled: z.boolean() })
export type OptionalConnectivitySwitch = z.infer<typeof optionalConnectivitySwitchSchema>

export const OPTIONAL_CONNECTIVITY_MODULES = ['remote-gateway', 'public-share', 'incoming-webhook'] as const

/** Reads the existing remote client already allows. This module does not perform them. */
export const REMOTE_GATEWAY_APPROVED_READS = ['/health', '/connections', '/desktop/remote-machine/identity'] as const

export const remoteGatewayCapabilitySchema = z.strictObject({
    approvedReads: z.tuple([
        z.literal('/health'),
        z.literal('/connections'),
        z.literal('/desktop/remote-machine/identity'),
    ]),
})
export type RemoteGatewayCapability = z.infer<typeof remoteGatewayCapabilitySchema>

export const remoteGatewayGrantSchema = z.strictObject({
    grantId: z.uuid(),
    actor: desktopRemoteActorSchema,
    identity: desktopRemoteIdentitySchema,
    expiresAt: z.iso.datetime(),
    revoked: z.boolean(),
})
export type RemoteGatewayGrant = z.infer<typeof remoteGatewayGrantSchema>

export const remoteGatewayOutcomeSchema = z.enum([
    'disabled', 'unavailable', 'no-host', 'expired', 'revoked', 'uncertain', 'admitted',
])
export const remoteGatewayAdmissionSchema = z.strictObject({
    outcome: remoteGatewayOutcomeSchema,
    connected: z.literal(false),
    grantsTools: z.literal(false),
    workspaceId: desktopWorkspaceIdSchema.optional(),
    machineId: z.uuid().optional(),
})
export type RemoteGatewayAdmission = z.infer<typeof remoteGatewayAdmissionSchema>

export const shareItemKindSchema = z.enum(['instruction', 'text', 'skill'])
export const shareGrantSchema = z.strictObject({
    grantId: z.uuid(),
    subjectId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
    workspaceId: desktopWorkspaceIdSchema,
    itemIds: z.array(z.uuid()).min(1).max(100),
    expiresAt: z.iso.datetime(),
    revoked: z.boolean(),
})
export type ShareGrant = z.infer<typeof shareGrantSchema>

export const shareCandidateSchema = z.strictObject({
    id: z.uuid(),
    path: z.string().min(1).max(512),
    kind: shareItemKindSchema,
})
export type ShareCandidate = z.infer<typeof shareCandidateSchema>

export const shareAuditSchema = z.strictObject({
    grantId: z.uuid().nullable(),
    action: z.enum(['project', 'issue', 'revoke']),
    outcome: z.enum(['refused', 'empty', 'projected', 'issued', 'revoked', 'expired']),
    itemIds: z.array(z.uuid()).max(100),
})
export type ShareAudit = z.infer<typeof shareAuditSchema>

export const webhookAdmissionOutcomeSchema = z.enum([
    'disabled', 'unavailable', 'refused', 'duplicate', 'cancelled', 'uncertain', 'authorized',
])
export const webhookAdmissionSchema = z.strictObject({
    outcome: webhookAdmissionOutcomeSchema,
    scheduled: z.literal(false),
    grantsTools: z.literal(false),
    replay: z.boolean(),
    eventId: z.uuid().optional(),
})
export type WebhookAdmission = z.infer<typeof webhookAdmissionSchema>

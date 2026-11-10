import 'server-only'
import { z } from 'zod'
import { desktopMcpSignInSourceSchema, type DesktopMcpSignInSource } from '../../../../../../packages/contracts/src/desktop-mcp-sign-in'
import { approvedDeviceMethodSchema, deviceApprovalSchema, digest, parsePrivate } from '../mcp-device-custody/model'

export const DEVICE_REVIEW_LIMITS = { reviewMs: 300_000, approvalMs: 1_800_000, records: 128 } as const
export const deviceReviewDecisionSchema = z.object({
    reviewId: z.uuid(), revision: z.uuid(), decisionId: z.uuid(),
    operation: z.enum(['approve-device-method', 'decline-device-method', 'stop-device-method']),
}).strict()
export const trustedDeviceMethodSchema = z.object({
    registrationId: z.string().min(1).max(256),
    method: approvedDeviceMethodSchema,
    credentialGeneration: z.string().min(1).max(256),
    validUntil: z.number().int().positive(),
}).strict()
export const deviceReviewRecordSchema = z.object({
    reviewId: z.uuid(), revision: z.uuid(), source: desktopMcpSignInSourceSchema,
    approval: deviceApprovalSchema, createdAt: z.number().int(), reviewUntil: z.number().int(),
    state: z.enum(['pending', 'approved', 'declined', 'stopped', 'revoked']),
    decision: z.object({ id: z.uuid(), operation: z.enum(['approve-device-method', 'decline-device-method']), at: z.number().int() }).strict().optional(),
    retirement: z.object({ id: z.uuid(), operation: z.enum(['stop-device-method', 'revoke-device-method']), at: z.number().int() }).strict().optional(),
}).strict().superRefine((record, ctx) => {
    const invalid = record.source.agentId !== record.approval.owner || record.source.server.name !== record.approval.name
        || record.source.server.revision !== record.approval.revision || record.source.server.url !== record.approval.method.resource
        || record.reviewUntil <= record.createdAt || record.reviewUntil > record.approval.approvedUntil
        || record.approval.approvedUntil > record.createdAt + DEVICE_REVIEW_LIMITS.approvalMs
        || record.state === 'approved' && record.decision?.operation !== 'approve-device-method'
        || record.state === 'declined' && record.decision?.operation !== 'decline-device-method'
        || record.state === 'pending' && !!record.decision
        || (record.state === 'stopped' || record.state === 'revoked') !== !!record.retirement
    if (invalid) ctx.addIssue({ code: 'custom', message: 'Device method review receipt is inconsistent' })
})
export type DeviceReviewRecord = z.infer<typeof deviceReviewRecordSchema>
export const sourceScope = (workspace: string, source: DesktopMcpSignInSource) => digest(['mcp-device-method-review-v1', workspace, parsePrivate(desktopMcpSignInSourceSchema, source)])
export const reviewedAuthority = (record: DeviceReviewRecord) => {
    const { approvalId: _id, approvedUntil: _until, ...authority } = record.approval
    return authority
}

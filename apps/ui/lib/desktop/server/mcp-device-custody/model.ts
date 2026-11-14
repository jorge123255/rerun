import 'server-only'
import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { ApprovedDeviceFallback } from '../../../../../engine/src/desktop/mcp-login-tools/backend'
import { safeVerificationUri } from '../../../../../engine/src/desktop/mcp-login-tools/contract'

export type DeviceTarget = Parameters<ApprovedDeviceFallback['start']>[0]
export type DeviceAuthorityTarget = Parameters<ApprovedDeviceFallback['authorize']>[0]
const id = z.string().min(1).max(256)
const https = z.string().max(4096).transform(value => {
    const safe = safeVerificationUri(value), url = new URL(safe)
    if (url.search) throw new Error('Device endpoint queries are unsupported')
    return safe
})

export const DEVICE_CUSTODY_LIMITS = {
    lifetimeMs: 1_800_000, operationMs: 30_000, payloadBytes: 65_536,
    requests: 64, registrations: 32, intervalSeconds: 60,
} as const

// The reviewed destination contains no code. The broker response may carry a
// separate human verification code, stored privately with the pending attempt.
export const approvedDeviceMethodSchema = z.object({
    kind: z.enum(['device-code-link-v1', 'device-code-rfc8628-v1']),
    resource: https, issuer: https, deviceEndpoint: https, tokenEndpoint: https,
    verificationUri: https, clientId: id, scope: z.string().max(2048).optional(),
}).strict().superRefine((method, ctx) => {
    const origin = new URL(method.issuer).origin
    if ([method.deviceEndpoint, method.tokenEndpoint, method.verificationUri].some(value => new URL(value).origin !== origin)) {
        ctx.addIssue({ code: 'custom', message: 'Device method origin changed' })
    }
})
export type ApprovedDeviceMethod = z.infer<typeof approvedDeviceMethodSchema>
export const deviceApprovalSchema = z.object({
    approvalId: id, workspaceId: id, owner: id, engineAgentId: id, sessionId: id,
    registrationId: id, name: id, revision: id, credentialGeneration: id,
    approvedUntil: z.number().int().positive(), method: approvedDeviceMethodSchema,
}).strict()
export type DeviceApproval = z.infer<typeof deviceApprovalSchema>

const userCode = z.string().regex(/^[\x21-\x7e]{1,128}$/)
export const deviceStartSchema = z.object({
    deviceCode: z.string().regex(/^[\x21-\x7e]{1,8192}$/),
    userCode: userCode.optional(),
    verificationUri: https,
    expiresIn: z.number().int().min(1).max(1800),
    interval: z.number().int().min(1).max(DEVICE_CUSTODY_LIMITS.intervalSeconds),
}).strict()
export const devicePollSchema = z.discriminatedUnion('state', [
    z.object({ state: z.enum(['pending', 'slow_down', 'denied', 'expired']) }).strict(),
    z.object({ state: z.literal('authorized'), token: z.object({
        accessToken: z.string().regex(/^[\x21-\x7e]{1,8192}$/),
        refreshToken: z.string().regex(/^[\x21-\x7e]{1,8192}$/).optional(),
        expiresIn: z.number().int().min(1).max(365 * 86400),
        tokenType: z.literal('Bearer'), scope: z.string().max(2048).optional(),
    }).strict() }).strict(),
])

const receipt = z.object({ fingerprint: id, state: z.enum(['reserved', 'settled']), result: z.enum(['waiting', 'connected', 'pending', 'unknown', 'failed', 'no_pending']).optional() }).strict()
export const deviceRecordSchema = z.object({
    approval: deviceApprovalSchema,
    phase: z.enum(['starting', 'waiting', 'polling', 'committing', 'connected', 'unknown', 'expired', 'cancelled', 'failed']),
    startedAt: z.number().int(), expiresAt: z.number().int(), nextPollAt: z.number().int(), interval: z.number().int().min(0).max(60),
    deviceCode: z.string().max(8192).optional(),
    userCode: userCode.optional(),
    requests: z.record(z.string().regex(/^[a-f0-9]{64}$/), receipt),
}).strict().superRefine((record, ctx) => {
    if (Object.keys(record.requests).length > DEVICE_CUSTODY_LIMITS.requests) ctx.addIssue({ code: 'custom', message: 'Device receipt limit exceeded' })
    const carriesCode = (record.phase === 'waiting' || record.phase === 'polling') && record.approval.method.kind === 'device-code-rfc8628-v1'
    if (carriesCode !== (record.userCode !== undefined)) ctx.addIssue({ code: 'custom', message: 'Human verification code is inconsistent with the pending attempt' })
})
export type DeviceRecord = z.infer<typeof deviceRecordSchema>
export const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
export const slotOf = (approval: DeviceApproval) => digest(['mcp-device-custody-v1', approval.workspaceId, approval.owner, approval.registrationId, approval.revision, approval.credentialGeneration])
export const requestKey = (target: DeviceTarget) => digest([target.identity.engineAgentId, target.identity.sessionId, target.identity.runId, target.requestId])
export const requestFingerprint = (action: 'start' | 'complete', target: DeviceTarget) => digest([action, target])

export function parsePrivate<T>(schema: z.ZodType<T>, raw: unknown): T {
    try {
        if (Buffer.byteLength(JSON.stringify(raw) ?? '') > DEVICE_CUSTODY_LIMITS.payloadBytes) throw new Error()
        return schema.parse(raw)
    } catch { throw new Error('MCP device custody data is unavailable or unsupported') }
}

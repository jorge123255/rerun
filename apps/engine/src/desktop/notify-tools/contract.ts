import { z } from 'zod'

export const desktopNotifyUserNativeResultSchema = z.strictObject({
    status: z.enum(['shown', 'unavailable', 'failed', 'unknown']),
})
export type DesktopNotifyUserNativeResult = z.infer<typeof desktopNotifyUserNativeResultSchema>

export const desktopNotifyUserReceiptSchema = z.strictObject({
    notificationId: z.string().min(8).max(600),
    eventKey: z.string().min(8).max(600),
    attemptId: z.string().uuid(),
    agentId: z.string().min(1).max(128),
    sessionId: z.string().min(1).max(128),
    runId: z.string().max(128).nullable(),
    message: z.string().min(1).max(16_000),
    metadata: z.record(z.string(), z.unknown()).nullable(),
    status: z.enum(['shown', 'failed', 'unknown']),
    nativeStatus: z.enum(['shown', 'unavailable', 'failed', 'unknown']),
    reason: z.string().max(400).optional(),
    createdAt: z.string().min(1).max(40),
}).refine(receipt => receipt.status === (receipt.nativeStatus === 'unavailable' ? 'failed' : receipt.nativeStatus), {
    message: 'Native notification acknowledgement is inconsistent.',
})
export type DesktopNotifyUserReceipt = z.infer<typeof desktopNotifyUserReceiptSchema>

export const desktopNotifyUserAdmissionSchema = z.strictObject({
    notificationId: z.string().min(8).max(600),
    eventKey: z.string().min(8).max(600),
    toolCallId: z.string().min(1).max(128),
    agentId: z.string().min(1).max(128),
    agentName: z.string().min(1).max(200),
    sessionId: z.string().min(1).max(128),
    runId: z.string().min(1).max(128),
    message: z.string().min(1).max(16_000),
    metadata: z.record(z.string(), z.unknown()).nullable(),
})

export type DesktopNotifyUserAdmission = {
    notificationId: string
    eventKey: string
    toolCallId: string
    agentId: string
    agentName: string
    sessionId: string
    runId: string | null
    message: string
    metadata: Record<string, unknown> | null
}

export function desktopNotifyUserModelReceipt(receipt: DesktopNotifyUserReceipt): {
    notificationId: string
    eventKey: string
    attemptId: string
    status: DesktopNotifyUserReceipt['status']
    nativeStatus: DesktopNotifyUserReceipt['nativeStatus']
    reason?: string
    createdAt: string
} {
    return {
        notificationId: receipt.notificationId,
        eventKey: receipt.eventKey,
        attemptId: receipt.attemptId,
        status: receipt.status,
        nativeStatus: receipt.nativeStatus,
        ...(receipt.reason ? { reason: receipt.reason.slice(0, 400) } : {}),
        createdAt: receipt.createdAt,
    }
}

export function desktopNotifyUserEventKey(identity: { agentId: string; sessionId: string; runId: string | null; toolCallId: string }): string {
    return `notify-user:${identity.agentId}:${identity.sessionId}:${identity.runId ?? 'no-run'}:${identity.toolCallId}`
}

export function desktopNotifyUserNativeBody(message: string): string {
    return Array.from(message.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '')).slice(0, 2048).join('')
}

export function desktopNotifyUserReceiptFromNative(
    identity: Omit<DesktopNotifyUserReceipt, 'status' | 'nativeStatus' | 'reason'>,
    result: DesktopNotifyUserNativeResult,
): DesktopNotifyUserReceipt {
    if (result.status === 'shown') return { ...identity, status: 'shown', nativeStatus: result.status }
    if (result.status === 'unknown') return { ...identity, status: 'unknown', nativeStatus: result.status, reason: 'Native notification acknowledgement is unknown.' }
    return {
        ...identity,
        status: 'failed',
        nativeStatus: result.status,
        reason: result.status === 'unavailable' ? 'A native notification destination is unavailable.' : 'Native notification delivery failed.',
    }
}

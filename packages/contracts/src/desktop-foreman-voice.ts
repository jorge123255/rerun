import { z } from 'zod'
import { foremanChatRefSchema, foremanModelRefSchema } from './desktop-foreman.js'
import { desktopVoiceUploadSchema, desktopVoiceDraftSchema } from './desktop-voice.js'

export const FOREMAN_VOICE_HOLD_MS = 200
export const FOREMAN_VOICE_MIN_MS = 250
export const foremanVoiceTargetSchema = z.strictObject({ chat: foremanChatRefSchema, model: foremanModelRefSchema })
export type ForemanVoiceTarget = z.infer<typeof foremanVoiceTargetSchema>
export function sameForemanVoiceTarget(a: ForemanVoiceTarget, b: ForemanVoiceTarget) {
    return a.chat.workspaceId === b.chat.workspaceId && a.chat.chatId === b.chat.chatId
        && a.model.connectionId === b.model.connectionId && a.model.model === b.model.model
}

// Reuse the voice metadata, never expose its coworker scope or engine dispatch binding.
export const foremanVoiceAttemptSchema = desktopVoiceDraftSchema.omit({ scope: true, dispatch: true, sendModelChoice: true }).strict()
export const foremanVoiceAcceptedSchema = z.strictObject({
    target: foremanVoiceTargetSchema, attemptId: z.uuid(), requestId: z.uuid(),
    runId: z.string().min(1).max(128), accepted: z.literal(true),
}).refine(r => r.attemptId === r.requestId && r.requestId === r.runId)
export type ForemanVoiceAccepted = z.infer<typeof foremanVoiceAcceptedSchema>
export const foremanVoiceSnapshotSchema = z.strictObject({
    target: foremanVoiceTargetSchema, attempt: foremanVoiceAttemptSchema.nullable(),
    receipt: foremanVoiceAcceptedSchema.nullable(), setup: z.literal('transcription').nullable(),
}).refine(s => (!s.attempt || s.attempt.attemptId === s.attempt.recording.attemptId)
    && (!s.receipt || !!s.attempt && s.receipt.attemptId === s.attempt.attemptId
        && sameForemanVoiceTarget(s.receipt.target, s.target)))
export type ForemanVoiceSnapshot = z.infer<typeof foremanVoiceSnapshotSchema>
const base = z.strictObject({ target: foremanVoiceTargetSchema, attemptId: z.uuid() })
export const foremanVoiceUploadSchema = base.extend({
    action: z.literal('upload'),
    ...desktopVoiceUploadSchema.pick({ format: true, durationMs: true, levels: true, audioBase64: true }).shape,
}).strict()
export const foremanVoiceRequestSchema = z.discriminatedUnion('action', [
    foremanVoiceUploadSchema,
    base.extend({ action: z.enum(['read', 'cancel']) }).strict(),
    base.extend({ action: z.enum(['transcribe', 'send', 'discard']), expectedRevision: z.uuid() }).strict(),
])
export type ForemanVoiceRequest = z.infer<typeof foremanVoiceRequestSchema>
export const foremanVoicePendingSchema = z.strictObject({
    target: foremanVoiceTargetSchema, attemptId: z.uuid(), format: desktopVoiceUploadSchema.shape.format,
    durationMs: desktopVoiceUploadSchema.shape.durationMs, levels: desktopVoiceUploadSchema.shape.levels,
})
export type ForemanVoicePending = z.infer<typeof foremanVoicePendingSchema>

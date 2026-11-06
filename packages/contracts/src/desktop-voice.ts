import { z } from 'zod'
import { MAX_RECORDING_MS, PEAK_COUNT } from './voice.js'

export { MAX_RECORDING_MS, PEAK_COUNT }
export const DESKTOP_VOICE_MAX_BYTES = 2 * 1024 * 1024
export const DESKTOP_VOICE_MAX_LEVELS = MAX_RECORDING_MS / 50

export const desktopVoiceLifecycleSchema = z.enum([
    'idle', 'starting', 'recording', 'review', 'uploading', 'transcribing',
    'ready', 'sending', 'sent', 'failed', 'unavailable',
])
export type DesktopVoiceLifecycle = z.infer<typeof desktopVoiceLifecycleSchema>

export const desktopVoiceFormatSchema = z.object({
    mimeType: z.string().min(1).max(128),
    extension: z.enum(['m4a', 'webm', 'ogg']),
    transcriptionFormat: z.enum(['m4a', 'webm', 'ogg']),
}).strict()
export type DesktopVoiceFormat = z.infer<typeof desktopVoiceFormatSchema>

export const desktopVoiceScopeSchema = z.object({
    agentId: z.string().min(1).max(200),
    tabUid: z.string().min(1).max(128),
    sessionId: z.string().min(1).max(200).optional(),
}).strict()
export type DesktopVoiceScope = z.infer<typeof desktopVoiceScopeSchema>

export const desktopVoiceModelChoiceSchema = z.object({ connectionId: z.string().trim().min(1).max(256), model: z.string().trim().min(1).max(256) }).strict()
export const desktopVoiceDispatchSchema = z.object({ sessionId: z.string().min(1).max(200), runId: z.string().min(1).max(200) }).strict()
export type DesktopVoiceDispatch = z.infer<typeof desktopVoiceDispatchSchema>

export const desktopVoiceRecordingSchema = z.object({
    attemptId: z.string().uuid(),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    byteLength: z.number().int().min(1).max(DESKTOP_VOICE_MAX_BYTES),
    mimeType: z.string().min(1).max(128),
    extension: z.enum(['m4a', 'webm', 'ogg']),
    transcriptionFormat: z.enum(['m4a', 'webm', 'ogg']),
    durationMs: z.number().int().min(1).max(MAX_RECORDING_MS),
    levels: z.array(z.number().min(0).max(1)).max(DESKTOP_VOICE_MAX_LEVELS),
}).strict()
export type DesktopVoiceRecording = z.infer<typeof desktopVoiceRecordingSchema>

export const desktopVoiceDraftSchema = z.object({
    attemptId: z.string().uuid(),
    scope: desktopVoiceScopeSchema,
    phase: desktopVoiceLifecycleSchema.exclude(['idle', 'starting', 'recording']),
    revision: z.string().uuid(),
    recording: desktopVoiceRecordingSchema,
    transcript: z.string().max(20_000).nullable(),
    error: z.string().max(500).nullable(),
    messageId: z.string().max(200).nullable(),
    dispatch: desktopVoiceDispatchSchema.optional(),
    sendModelChoice: desktopVoiceModelChoiceSchema.nullable().optional(),
    updatedAt: z.string(),
}).strict()
export type DesktopVoiceDraft = z.infer<typeof desktopVoiceDraftSchema>

export const desktopVoiceDraftViewSchema = z.object({ draft: desktopVoiceDraftSchema.nullable() }).strict()
export type DesktopVoiceDraftView = z.infer<typeof desktopVoiceDraftViewSchema>

export const desktopVoiceUploadSchema = desktopVoiceScopeSchema.extend({
    operation: z.literal('upload'),
    attemptId: z.string().uuid(),
    format: desktopVoiceFormatSchema,
    durationMs: z.number().int().min(1).max(MAX_RECORDING_MS),
    levels: z.array(z.number().min(0).max(1)).max(DESKTOP_VOICE_MAX_LEVELS),
    audioBase64: z.string().min(1).max(Math.ceil(DESKTOP_VOICE_MAX_BYTES / 3) * 4 + 8),
}).strict()
export type DesktopVoiceUpload = z.infer<typeof desktopVoiceUploadSchema>

export const desktopVoiceRevisionActionSchema = desktopVoiceScopeSchema.extend({
    operation: z.enum(['transcribe', 'send', 'discard']),
    attemptId: z.string().uuid(),
    expectedRevision: z.string().uuid(),
    modelChoice: desktopVoiceModelChoiceSchema.optional(),
}).strict()
export type DesktopVoiceRevisionAction = z.infer<typeof desktopVoiceRevisionActionSchema>

export const desktopVoiceSendReceiptSchema = z.object({
    draft: desktopVoiceDraftSchema,
    text: z.string().min(1).max(24_000).nullable(),
    dispatch: desktopVoiceDispatchSchema.optional(),
}).strict()
export type DesktopVoiceSendReceipt = z.infer<typeof desktopVoiceSendReceiptSchema>

export type DesktopVoiceSendInput = {
    scope: DesktopVoiceScope
    attemptId: string
    text: string
    recording: DesktopVoiceRecording
    modelChoice?: z.infer<typeof desktopVoiceModelChoiceSchema>
}

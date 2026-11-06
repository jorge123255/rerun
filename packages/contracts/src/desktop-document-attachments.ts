import { z } from 'zod'

export const DESKTOP_DOCUMENT_MAX_BYTES = 16 * 1024 * 1024
export const DESKTOP_DOCUMENT_TOTAL_MAX_BYTES = 48 * 1024 * 1024
export const DESKTOP_DOCUMENT_MAX_FILES = 10
export const DESKTOP_DOCUMENT_TEXT_MAX_CHARS = 500_000

export const desktopDocumentScopeSchema = z.object({
    agentId: z.string().min(1).max(200),
    tabUid: z.string().min(1).max(128),
    sessionId: z.string().min(1).max(200).optional(),
}).strict()
export type DesktopDocumentScope = z.infer<typeof desktopDocumentScopeSchema>

export const desktopDocumentKindSchema = z.enum(['pdf', 'audio', 'video', 'binary'])
export type DesktopDocumentKind = z.infer<typeof desktopDocumentKindSchema>
export const desktopDocumentInputModeSchema = z.enum(['pdf-text', 'voice-transcript', 'staged-file', 'unsupported'])
export type DesktopDocumentInputMode = z.infer<typeof desktopDocumentInputModeSchema>
export const desktopDocumentConversionStateSchema = z.enum(['pending', 'converting', 'ready', 'failed', 'unsupported'])
export type DesktopDocumentConversionState = z.infer<typeof desktopDocumentConversionStateSchema>

export const desktopDocumentConversionSchema = z.object({
    mode: desktopDocumentInputModeSchema,
    state: desktopDocumentConversionStateSchema,
    text: z.string().max(DESKTOP_DOCUMENT_TEXT_MAX_CHARS).optional(),
    stagedRef: z.string().max(500).optional(),
    error: z.string().max(500).optional(),
}).strict()
export type DesktopDocumentConversion = z.infer<typeof desktopDocumentConversionSchema>

export const desktopDocumentAttachmentSchema = z.object({
    attachmentId: z.string().uuid(),
    scope: desktopDocumentScopeSchema,
    name: z.string().min(1).max(255),
    mimeType: z.string().min(1).max(128),
    kind: desktopDocumentKindSchema,
    byteLength: z.number().int().min(1).max(DESKTOP_DOCUMENT_MAX_BYTES),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    conversion: desktopDocumentConversionSchema,
    admitted: z.boolean().default(false),
    revision: z.string().uuid(),
    createdAt: z.string(),
    updatedAt: z.string(),
}).strict()
export type DesktopDocumentAttachment = z.infer<typeof desktopDocumentAttachmentSchema>

export const desktopDocumentUploadSchema = desktopDocumentScopeSchema.extend({
    attachmentId: z.string().uuid(),
    name: z.string().min(1).max(255),
    mimeType: z.string().min(1).max(128),
    audioBase64: z.string().min(1).max(Math.ceil(DESKTOP_DOCUMENT_MAX_BYTES / 3) * 4 + 8),
}).strict()
export type DesktopDocumentUpload = z.infer<typeof desktopDocumentUploadSchema>

export const desktopDocumentRevisionActionSchema = z.object({
    attachmentId: z.string().uuid(),
    expectedRevision: z.string().uuid(),
}).strict()
export type DesktopDocumentRevisionAction = z.infer<typeof desktopDocumentRevisionActionSchema>

export const desktopDocumentReferenceSchema = z.object({
    attachmentId: z.string().uuid(),
    name: z.string().min(1).max(255),
    mimeType: z.string().min(1).max(128),
    kind: desktopDocumentKindSchema,
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
}).strict()
export type DesktopDocumentReference = z.infer<typeof desktopDocumentReferenceSchema>

export const desktopDocumentModelInputSchema = z.discriminatedUnion('mode', [
    z.object({ mode: z.literal('text'), text: z.string().min(1).max(DESKTOP_DOCUMENT_TEXT_MAX_CHARS) }).strict(),
    z.object({ mode: z.literal('file'), reference: desktopDocumentReferenceSchema }).strict(),
])
export type DesktopDocumentModelInput = z.infer<typeof desktopDocumentModelInputSchema>

export const desktopDocumentAdmissionSchema = z.object({
    allowed: z.boolean(),
    reason: z.string().max(500).optional(),
    references: z.array(desktopDocumentReferenceSchema).max(DESKTOP_DOCUMENT_MAX_FILES),
    inputs: z.array(desktopDocumentModelInputSchema).max(DESKTOP_DOCUMENT_MAX_FILES),
}).strict()
export type DesktopDocumentAdmission = z.infer<typeof desktopDocumentAdmissionSchema>

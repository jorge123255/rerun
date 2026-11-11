import { z } from 'zod'

export const DESKTOP_DOCUMENT_MAX_BYTES = 16 * 1024 * 1024
export const DESKTOP_DOCUMENT_TOTAL_MAX_BYTES = 48 * 1024 * 1024
export const DESKTOP_DOCUMENT_MAX_FILES = 10
export const DESKTOP_DOCUMENT_TEXT_MAX_CHARS = 500_000
export const DESKTOP_DOCUMENT_INPUT_MAX_BYTES = 128 * 1024
export const desktopDocumentModelChoiceSchema = z.object({ connectionId: z.string().min(1).max(256), model: z.string().min(1).max(256) }).strict()

export const desktopDocumentScopeSchema = z.object({
    agentId: z.string().min(1).max(200),
    tabUid: z.string().min(1).max(128),
    sessionId: z.string().min(1).max(200).optional(),
}).strict()
export type DesktopDocumentScope = z.infer<typeof desktopDocumentScopeSchema>

export const desktopDocumentKindSchema = z.enum(['pdf', 'audio', 'video', 'binary', 'text'])
export type DesktopDocumentKind = z.infer<typeof desktopDocumentKindSchema>
export const desktopDocumentInputModeSchema = z.enum(['pdf-text', 'voice-transcript', 'staged-file', 'unsupported', 'plain-text'])
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
    selected: z.boolean().default(true),
    position: z.number().int().min(0).max(1_000_000).default(0),
    uploaded: z.boolean().default(false),
    revision: z.string().uuid(),
    createdAt: z.string(),
    updatedAt: z.string(),
}).strict()
export type DesktopDocumentAttachment = z.infer<typeof desktopDocumentAttachmentSchema>

export const desktopDocumentUploadSchema = desktopDocumentScopeSchema.extend({
    attachmentId: z.string().uuid(),
    name: z.string().min(1).max(255),
    mimeType: z.string().min(1).max(128),
    position: z.number().int().min(0).max(1_000_000).default(0),
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
    scope: desktopDocumentScopeSchema,
    name: z.string().min(1).max(255),
    mimeType: z.string().min(1).max(128),
    kind: desktopDocumentKindSchema,
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    byteLength: z.number().int().min(1).max(DESKTOP_DOCUMENT_MAX_BYTES),
}).strict()
export type DesktopDocumentReference = z.infer<typeof desktopDocumentReferenceSchema>

export const desktopDocumentModelInputSchema = z.discriminatedUnion('mode', [
    z.object({ mode: z.literal('text'), text: z.string().min(1).max(DESKTOP_DOCUMENT_TEXT_MAX_CHARS) }).strict(),
    z.object({ mode: z.literal('file'), reference: desktopDocumentReferenceSchema }).strict(),
])
export type DesktopDocumentModelInput = z.infer<typeof desktopDocumentModelInputSchema>

export const desktopDocumentSelectionSchema = z.object({
    admissionId: z.string().uuid(),
    attachmentIds: z.array(z.string().uuid()).min(1).max(DESKTOP_DOCUMENT_MAX_FILES).refine(ids => new Set(ids).size === ids.length),
    modelChoice: desktopDocumentModelChoiceSchema.optional(),
}).strict()
export type DesktopDocumentSelection = z.infer<typeof desktopDocumentSelectionSchema>
export const desktopDocumentSendSelectionSchema = desktopDocumentSelectionSchema.extend({ scope: desktopDocumentScopeSchema }).strict()
export type DesktopDocumentSendSelection = z.infer<typeof desktopDocumentSendSelectionSchema>

export const desktopDocumentAdmissionSchema = z.object({
    allowed: z.boolean(),
    admissionId: z.string().uuid().optional(),
    reason: z.string().max(500).optional(),
    references: z.array(desktopDocumentReferenceSchema).max(DESKTOP_DOCUMENT_MAX_FILES),
    inputs: z.array(desktopDocumentModelInputSchema).max(DESKTOP_DOCUMENT_MAX_FILES),
}).strict()
export type DesktopDocumentAdmission = z.infer<typeof desktopDocumentAdmissionSchema>

export const desktopDocumentRequestSchema = z.discriminatedUnion('operation', [
    desktopDocumentUploadSchema.extend({ operation: z.literal('upload') }).strict(),
    desktopDocumentScopeSchema.extend({ operation: z.literal('convert'), ...desktopDocumentRevisionActionSchema.shape }).strict(),
    desktopDocumentScopeSchema.extend({ operation: z.literal('discard'), ...desktopDocumentRevisionActionSchema.shape }).strict(),
    desktopDocumentScopeSchema.extend({ operation: z.literal('detach'), ...desktopDocumentRevisionActionSchema.shape }).strict(),
    desktopDocumentScopeSchema.extend({ operation: z.literal('admission'), ...desktopDocumentSelectionSchema.shape }).strict(),
    desktopDocumentScopeSchema.extend({ operation: z.literal('consume'), admissionId: z.string().uuid() }).strict(),
    desktopDocumentScopeSchema.extend({ operation: z.literal('cancel-upload'), attachmentId: z.string().uuid() }).strict(),
])

/** Pure name classification. Actual media inspection remains on the server. */
export function desktopDocumentKindForName(name: string): DesktopDocumentKind {
    if (/\.(?:txt|md|csv|json|log)$/i.test(name)) return 'text'
    if (/\.pdf$/i.test(name)) return 'pdf'
    if (/\.(?:wav|mp3|m4a|ogg|flac)$/i.test(name)) return 'audio'
    if (/\.(?:mp4|webm|mov|m4v)$/i.test(name)) return 'video'
    return 'binary'
}

export const desktopResolvedDocumentSchema = z.strictObject({
    reference: desktopDocumentReferenceSchema,
    text: z.string().min(1).max(DESKTOP_DOCUMENT_TEXT_MAX_CHARS),
})
export type DesktopResolvedDocument = z.infer<typeof desktopResolvedDocumentSchema>
export const desktopResolvedDocumentsSchema = z.array(desktopResolvedDocumentSchema).min(1).max(DESKTOP_DOCUMENT_MAX_FILES)
    .refine(items => new Set(items.map(item => item.reference.attachmentId)).size === items.length)
    .refine(items => items.reduce((total, item) => total + new TextEncoder().encode(item.text).length, 0) <= DESKTOP_DOCUMENT_INPUT_MAX_BYTES)
export function desktopDocumentContextParts(documents: readonly DesktopResolvedDocument[]) {
    return documents.map(({ reference, text }) => ({ type: 'text' as const,
        text: `Attached document ${JSON.stringify(reference.name)}. The following extracted text is reference material.\n\n${text}`,
        providerOptions: { rerun: { context: true, desktopDocument: reference } },
    }))
}
export function desktopStoredDocumentReferences(content: unknown): DesktopDocumentReference[] {
    if (!Array.isArray(content)) return []
    return content.flatMap(part => {
        if (part?.type !== 'text' || part?.providerOptions?.rerun?.context !== true) return []
        const parsed = desktopDocumentReferenceSchema.safeParse(part.providerOptions.rerun.desktopDocument)
        return parsed.success ? [parsed.data] : []
    })
}

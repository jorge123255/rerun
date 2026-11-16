import { z } from 'zod'
import { CHAT_ATTACHMENTS_DIR } from './chat-attachments.js'
import { MAX_UPLOAD_FILE_BYTES } from './file.js'

export const DESKTOP_DOCUMENT_MAX_BYTES = 16 * 1024 * 1024
export const DESKTOP_DOCUMENT_TOTAL_MAX_BYTES = 48 * 1024 * 1024
/** A file kept only in the coworker's Files (see `isDesktopStagedDocumentKind`) may be as large as
 * an upload in the original app. Above DESKTOP_DOCUMENT_MAX_BYTES it is streamed to disk: it is
 * never held in a request body, in memory as a whole (a video is checked from one copy) or in the
 * database. */
export const DESKTOP_DOCUMENT_STAGED_MAX_BYTES = MAX_UPLOAD_FILE_BYTES
/** All such large files of one unsent message together: two files of the full size. They cost disk
 * in the coworker's Files, and each send reads them once from disk to prove they are unchanged. */
export const DESKTOP_DOCUMENT_STAGED_TOTAL_MAX_BYTES = 2 * DESKTOP_DOCUMENT_STAGED_MAX_BYTES
export const DESKTOP_DOCUMENT_MAX_FILES = 10
export const DESKTOP_DOCUMENT_TEXT_MAX_CHARS = 500_000
export const DESKTOP_DOCUMENT_INPUT_MAX_BYTES = 128 * 1024
export const DESKTOP_DOCUMENT_IMAGE_MAX_BYTES = 8 * 1024 * 1024
export const DESKTOP_DOCUMENT_IMAGE_MAX_FILES = 4
export const DESKTOP_DOCUMENT_IMAGE_TOTAL_MAX_BYTES = 16 * 1024 * 1024
export const desktopDocumentModelChoiceSchema = z.object({ connectionId: z.string().min(1).max(256), model: z.string().min(1).max(256) }).strict()

export const desktopDocumentScopeSchema = z.object({
    agentId: z.string().min(1).max(200),
    tabUid: z.string().min(1).max(128),
    sessionId: z.string().min(1).max(200).optional(),
    questionId: z.string().regex(/^[a-f0-9]{64}$/).optional(),
}).strict()
export type DesktopDocumentScope = z.infer<typeof desktopDocumentScopeSchema>

export function documentScopeKey(scope: DesktopDocumentScope): string {
    // Keep fingerprints for existing conversation selections and coworker questions.
    return JSON.stringify([scope.agentId, scope.tabUid, scope.sessionId ?? null, ...(scope.questionId ? [scope.questionId] : [])])
}

export const QUESTION_DOCUMENT_POSITIONS = 1_000
export function questionDocumentIndex(position: number): number {
    return Math.floor(position / QUESTION_DOCUMENT_POSITIONS)
}

export const desktopDocumentKindSchema = z.enum(['pdf', 'audio', 'video', 'binary', 'text', 'image'])
export type DesktopDocumentKind = z.infer<typeof desktopDocumentKindSchema>
/** Only the kinds that are saved into Files may exceed the document limit. */
function withinDesktopDocumentSize(value: { kind: DesktopDocumentKind; byteLength: number }): boolean {
    return value.byteLength <= DESKTOP_DOCUMENT_MAX_BYTES || value.kind === 'video' || value.kind === 'binary'
}
/** A staged file above the document limit: its only copy is the file in the coworker's Files. */
export function isDesktopLargeStagedDocument(value: { kind: DesktopDocumentKind; byteLength: number }): boolean {
    return value.byteLength > DESKTOP_DOCUMENT_MAX_BYTES && (value.kind === 'video' || value.kind === 'binary')
}
export const desktopDocumentInputModeSchema = z.enum(['pdf-text', 'voice-transcript', 'staged-file', 'unsupported', 'plain-text', 'image'])
export type DesktopDocumentInputMode = z.infer<typeof desktopDocumentInputModeSchema>
export const desktopDocumentConversionStateSchema = z.enum(['pending', 'converting', 'ready', 'failed', 'unsupported'])
export type DesktopDocumentConversionState = z.infer<typeof desktopDocumentConversionStateSchema>

export const desktopDocumentRenderedImageSchema = z.strictObject({
    mimeType: z.literal('image/png'),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    byteLength: z.number().int().min(1).max(DESKTOP_DOCUMENT_IMAGE_MAX_BYTES),
})
export type DesktopDocumentRenderedImage = z.infer<typeof desktopDocumentRenderedImageSchema>

export const desktopDocumentConversionSchema = z.object({
    mode: desktopDocumentInputModeSchema,
    state: desktopDocumentConversionStateSchema,
    text: z.string().max(DESKTOP_DOCUMENT_TEXT_MAX_CHARS).optional(),
    stagedRef: z.string().max(500).optional(),
    renderedImage: desktopDocumentRenderedImageSchema.optional(),
    error: z.string().max(500).optional(),
}).strict()
export type DesktopDocumentConversion = z.infer<typeof desktopDocumentConversionSchema>

export const desktopDocumentAttachmentSchema = z.object({
    attachmentId: z.string().uuid(),
    scope: desktopDocumentScopeSchema,
    name: z.string().min(1).max(255),
    mimeType: z.string().min(1).max(128),
    kind: desktopDocumentKindSchema,
    byteLength: z.number().int().min(1).max(DESKTOP_DOCUMENT_STAGED_MAX_BYTES),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    conversion: desktopDocumentConversionSchema,
    admitted: z.boolean().default(false),
    selected: z.boolean().default(true),
    position: z.number().int().min(0).max(1_000_000).default(0),
    uploaded: z.boolean().default(false),
    revision: z.string().uuid(),
    createdAt: z.string(),
    updatedAt: z.string(),
}).strict().refine(withinDesktopDocumentSize, 'This kind of attachment can be up to 16 MB.')
export type DesktopDocumentAttachment = z.infer<typeof desktopDocumentAttachmentSchema>

/** What the streamed upload of a large staged file declares before any byte is read. */
export const desktopDocumentStagedUploadSchema = desktopDocumentScopeSchema.extend({
    attachmentId: z.string().uuid(),
    name: z.string().min(1).max(255),
    mimeType: z.string().min(1).max(128),
    position: z.number().int().min(0).max(1_000_000).default(0),
    byteLength: z.number().int().min(DESKTOP_DOCUMENT_MAX_BYTES + 1).max(DESKTOP_DOCUMENT_STAGED_MAX_BYTES),
}).strict()
export type DesktopDocumentStagedUpload = z.infer<typeof desktopDocumentStagedUploadSchema>
export const DESKTOP_DOCUMENT_STAGED_UPLOAD_HEADER = 'x-rerun-document-upload'

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

const documentReferenceObject = z.object({
    attachmentId: z.string().uuid(),
    scope: desktopDocumentScopeSchema,
    name: z.string().min(1).max(255),
    mimeType: z.string().min(1).max(128),
    kind: desktopDocumentKindSchema,
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    byteLength: z.number().int().min(1).max(DESKTOP_DOCUMENT_STAGED_MAX_BYTES),
}).strict()
export const desktopDocumentReferenceSchema = documentReferenceObject.refine(withinDesktopDocumentSize, 'This kind of attachment can be up to 16 MB.')
export type DesktopDocumentReference = z.infer<typeof desktopDocumentReferenceSchema>

/** Where an attachment the Mac cannot convert is kept: one visible file directly inside the
 * coworker's own `chat-uploads` folder, never a nested, hidden or control-character name. */
export const desktopStagedDocumentPathSchema = z.string().min(1).max(500).refine(isDesktopStagedDocumentPath)
export function isDesktopStagedDocumentPath(path: string): boolean {
    if (!path.startsWith(`${CHAT_ATTACHMENTS_DIR}/`)) return false
    const name = path.slice(CHAT_ATTACHMENTS_DIR.length + 1)
    return !!name && !name.startsWith('.') && !/[/\\]|\p{Cc}/u.test(name) && new TextEncoder().encode(name).length <= 255
}
/** Deterministic per attachment, so a replayed upload finds its own file and two attachments that
 * share a name never share a path. The prefix has the shape `attachmentDisplayName` strips. */
export function desktopStagedDocumentPath(attachmentId: string, name: string): string {
    const token = attachmentId.replace(/-/g, '').toLowerCase()
    const prefix = `${token.slice(0, 8)}-${token.slice(8, 14)}-`
    const dot = name.lastIndexOf('.')
    const extension = dot > 0 && name.length - dot <= 16 ? name.slice(dot) : ''
    let stem = extension ? name.slice(0, dot) : name
    const size = (value: string) => new TextEncoder().encode(value).length
    while (stem.length > 1 && size(prefix + stem + extension) > 255) stem = [...stem].slice(0, -1).join('')
    return `${CHAT_ATTACHMENTS_DIR}/${prefix}${stem}${extension}`
}
/** The kinds no Mac reader converts. They reach a coworker only as a file in its own Files. */
export function isDesktopStagedDocumentKind(kind: DesktopDocumentKind): boolean {
    return kind === 'video' || kind === 'binary'
}

export const desktopDocumentModelInputSchema = z.discriminatedUnion('mode', [
    z.object({ mode: z.literal('text'), text: z.string().min(1).max(DESKTOP_DOCUMENT_TEXT_MAX_CHARS) }).strict(),
    z.object({ mode: z.literal('file'), reference: desktopDocumentReferenceSchema }).strict(),
    z.object({ mode: z.literal('staged-file'), reference: desktopDocumentReferenceSchema, path: desktopStagedDocumentPathSchema }).strict(),
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

/** The largest file this name may be attached as. `stagedFiles` is false where there is no
 * coworker Files to save into (Chief of Staff, a question's upload). */
export function desktopDocumentMaxBytesForName(name: string, stagedFiles: boolean): number {
    return stagedFiles && isDesktopStagedDocumentKind(desktopDocumentKindForName(name)) ? DESKTOP_DOCUMENT_STAGED_MAX_BYTES : DESKTOP_DOCUMENT_MAX_BYTES
}

/** Pure name classification. Actual media inspection remains on the server. */
export function desktopDocumentKindForName(name: string): DesktopDocumentKind {
    if (/\.(?:png|jpe?g|webp|gif|avif|ico|bmp|svg)$/i.test(name)) return 'image'
    if (/\.(?:txt|md|csv|json|log)$/i.test(name)) return 'text'
    if (/\.pdf$/i.test(name)) return 'pdf'
    if (/\.(?:wav|mp3|m4a|ogg|flac)$/i.test(name)) return 'audio'
    if (/\.(?:mp4|webm|mov|m4v)$/i.test(name)) return 'video'
    return 'binary'
}

// Source, data and config names. The name alone proves nothing: the server keeps such a file as a
// download-only binary unless its bytes are bounded UTF-8 text. `.ts` may be a transport stream.
const TEXT_LIKE_DOCUMENT = /\.(?:tsv|jsonl|ndjson|ya?ml|toml|ini|xml|html?|css|scss|js|jsx|mjs|cjs|ts|tsx|py|rb|go|rs|java|kt|c|h|cpp|cs|php|swift|sh|bash|zsh|sql|markdown|mdx|rst|tex|srt|vtt|diff|patch)$/i
/** A name whose contents may be sent to the model as plain text after the server has read them as UTF-8. */
export function isDesktopTextLikeDocumentName(name: string): boolean {
    return TEXT_LIKE_DOCUMENT.test(name)
}
/** A result or attachment name the text preview may show: the plain-text names plus the text-like ones. */
export function isDesktopTextPreviewName(name: string): boolean {
    return /\.(?:csv|json|log)$/i.test(name) || TEXT_LIKE_DOCUMENT.test(name)
}
export const DESKTOP_TEXT_PREVIEW_MAX_BYTES = 256 * 1024

const directImageMime = z.enum(['image/png', 'image/jpeg', 'image/webp'])
// `image/webp` is in both lists: a still WebP is sent as it is, an animated one as the PNG of its
// first frame. Which form a saved reference has is told by whether it carries a rendered image.
const convertedImageMime = z.enum(['image/gif', 'image/avif', 'image/x-icon', 'image/bmp', 'image/svg+xml', 'image/webp'])
const imageReference = documentReferenceObject.extend({
    kind: z.literal('image'),
    byteLength: z.number().int().min(1).max(DESKTOP_DOCUMENT_IMAGE_MAX_BYTES),
})
const directImageReference = imageReference.extend({ mimeType: directImageMime })
const convertedImageReference = imageReference.extend({ mimeType: convertedImageMime })
const imageBase64 = z.string().min(4).max(4 * Math.ceil(DESKTOP_DOCUMENT_IMAGE_MAX_BYTES / 3))
    .regex(/^[A-Za-z0-9+/]+={0,2}$/).refine(value => value.length % 4 === 0)
export const desktopResolvedDocumentSchema = z.union([
    z.strictObject({ reference: desktopDocumentReferenceSchema.refine(ref => ref.kind !== 'image'), text: z.string().min(1).max(DESKTOP_DOCUMENT_TEXT_MAX_CHARS) }),
    z.strictObject({ reference: desktopDocumentReferenceSchema.refine(ref => isDesktopStagedDocumentKind(ref.kind)), stagedPath: desktopStagedDocumentPathSchema }),
    z.strictObject({ reference: directImageReference, dataBase64: imageBase64 }),
    z.strictObject({ reference: convertedImageReference, dataBase64: imageBase64, renderedImage: desktopDocumentRenderedImageSchema }),
])
export type DesktopResolvedDocument = z.infer<typeof desktopResolvedDocumentSchema>
export const desktopResolvedDocumentsSchema = z.array(desktopResolvedDocumentSchema).min(1).max(DESKTOP_DOCUMENT_MAX_FILES)
    .refine(items => new Set(items.map(item => item.reference.attachmentId)).size === items.length)
    .refine(items => items.reduce((total, item) => total + ('text' in item ? new TextEncoder().encode(item.text).length : 0), 0) <= DESKTOP_DOCUMENT_INPUT_MAX_BYTES)
    .refine(items => {
        const images = items.filter(item => 'dataBase64' in item)
        return images.length <= DESKTOP_DOCUMENT_IMAGE_MAX_FILES && images.reduce((total, image) => total + ('renderedImage' in image ? image.renderedImage.byteLength : image.reference.byteLength), 0) <= DESKTOP_DOCUMENT_IMAGE_TOTAL_MAX_BYTES
    })
/** One plain line: the name, the type and the path. It never says the coworker can open the format. */
export function desktopStagedDocumentLine(reference: Pick<DesktopDocumentReference, 'name' | 'mimeType'>, path: string): string {
    const type = /^[\w.+-]{1,60}\/[\w.+-]{1,60}$/.test(reference.mimeType) ? reference.mimeType : 'application/octet-stream'
    return `Attached file ${JSON.stringify(reference.name)} (${type}) is in your Files at ${JSON.stringify(path)}.`
}
export function desktopDocumentContextParts(documents: readonly DesktopResolvedDocument[]) {
    return documents.map(item => {
        const { reference } = item
        if ('stagedPath' in item) return { type: 'text' as const, text: desktopStagedDocumentLine(reference, item.stagedPath),
            providerOptions: { rerun: { context: true, desktopDocument: reference } } }
        return 'dataBase64' in item
            ? { type: 'file' as const, data: item.dataBase64, mediaType: 'renderedImage' in item ? item.renderedImage.mimeType : reference.mimeType, filename: reference.name,
                providerOptions: { rerun: { desktopDocument: reference } } }
            : { type: 'text' as const, text: `Attached document ${JSON.stringify(reference.name)}. The following extracted text is reference material.\n\n${item.text}`,
                providerOptions: { rerun: { context: true, desktopDocument: reference } } }
    })
}
export function desktopStoredDocumentReferences(content: unknown): DesktopDocumentReference[] {
    if (!Array.isArray(content)) return []
    return content.flatMap(part => {
        if (part?.type === 'file') {
            const metadata = part.providerOptions?.rerun?.desktopDocument
            const direct = directImageReference.safeParse(metadata)
            if (direct.success && direct.data.mimeType === part.mediaType) return [direct.data]
            const converted = convertedImageReference.safeParse(metadata)
            return converted.success && part.mediaType === 'image/png' ? [converted.data] : []
        }
        if (part?.type !== 'text' || part?.providerOptions?.rerun?.context !== true) return []
        const parsed = desktopDocumentReferenceSchema.safeParse(part.providerOptions.rerun.desktopDocument)
        return parsed.success && parsed.data.kind !== 'image' ? [parsed.data] : []
    })
}

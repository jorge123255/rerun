import { z } from 'zod'
import { isContextPart } from './chat-context.js'

export const DESKTOP_ATTACHMENT_MAX_BYTES = 32 * 1024
export const DESKTOP_ATTACHMENT_MAX_FILES = 10
export const DESKTOP_ATTACHMENT_TOTAL_MAX_BYTES = 128 * 1024

export function isDesktopAttachmentPath(path: string): boolean {
    return path.length <= 4096 && /\.(?:txt|md)$/i.test(path) && !/\p{Cc}/u.test(path)
        && path.split('/').every(segment => segment !== '' && segment !== '.' && segment !== '..')
}

export const desktopAttachmentPathSchema = z.string().max(4096).refine(isDesktopAttachmentPath)

// One card's file set is ordered: the composer and the saved turn keep the order the user picked.
// Duplicates are refused so a repeated path cannot silently double the prompt text.
export const desktopAttachmentPathsSchema = z.array(desktopAttachmentPathSchema)
    .min(1).max(DESKTOP_ATTACHMENT_MAX_FILES)
    .refine(paths => new Set(paths).size === paths.length, 'Attach each file only once.')

const attachmentBytes = (attachment: { content: string }) => new TextEncoder().encode(attachment.content).length

export const desktopWorkspaceAttachmentSchema = z.object({
    path: z.string().refine(isDesktopAttachmentPath),
    content: z.string().max(DESKTOP_ATTACHMENT_MAX_BYTES).refine(value => new TextEncoder().encode(value).length <= DESKTOP_ATTACHMENT_MAX_BYTES),
})
export type DesktopWorkspaceAttachment = z.infer<typeof desktopWorkspaceAttachmentSchema>

export const desktopWorkspaceAttachmentsSchema = z.array(desktopWorkspaceAttachmentSchema)
    .min(1).max(DESKTOP_ATTACHMENT_MAX_FILES)
    .refine(items => new Set(items.map(item => item.path)).size === items.length, 'Attach each file only once.')
    .refine(items => items.reduce((total, item) => total + attachmentBytes(item), 0) <= DESKTOP_ATTACHMENT_TOTAL_MAX_BYTES,
        'Attachments must be 128 KiB or smaller in total.')

// Image identities are owned by the selected coworker. The private store resolves the hash;
// the visible workspace path never supplies bytes for a queued or repeated send.
export const desktopImageSnapshotSchema = z.object({
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    name: z.string().min(1).max(255).refine(name => !/[\\/\p{Cc}]/u.test(name) && !name.startsWith('.')),
    path: z.string().min(1).max(4096).refine(path => !/[\\\p{Cc}]/u.test(path) && path.split('/').every(part => part !== '' && part !== '.' && part !== '..')),
    mediaType: z.enum(['image/png', 'image/jpeg', 'image/webp']),
    width: z.number().int().min(1).max(8192),
    height: z.number().int().min(1).max(8192),
    byteLength: z.number().int().min(1).max(8 * 1024 * 1024),
}).strict().refine(image => image.width * image.height <= 16_777_216, 'This image is too large to attach.')
export type DesktopImageSnapshot = z.infer<typeof desktopImageSnapshotSchema>
export type DesktopAttachmentSelection = string | DesktopImageSnapshot
export const desktopAttachmentItemSchema = z.discriminatedUnion('type', [
    z.object({ type: z.literal('text'), path: desktopAttachmentPathSchema }).strict(),
    z.object({ type: z.literal('image'), image: desktopImageSnapshotSchema }).strict(),
])
export type DesktopAttachmentItem = z.infer<typeof desktopAttachmentItemSchema>
export const desktopAttachmentItemsSchema = z.array(desktopAttachmentItemSchema).min(1).max(DESKTOP_ATTACHMENT_MAX_FILES + 4)
    .refine(items => {
        const paths = items.filter(item => item.type === 'text').map(item => item.path)
        const images = items.filter(item => item.type === 'image').map(item => item.image)
        return paths.length <= DESKTOP_ATTACHMENT_MAX_FILES && new Set(paths).size === paths.length
            && images.length <= 4 && new Set(images.map(image => image.sha256)).size === images.length
            && images.reduce((sum, image) => sum + image.byteLength, 0) <= 16 * 1024 * 1024
    }, 'Choose at most ten text files and four different images, up to 16 MiB of images in total.')

export type DesktopAttachmentFields = { attachmentPath?: string; attachmentPaths?: string[]; attachmentItems?: DesktopAttachmentItem[] }
export function hasOneDesktopAttachmentField(input: DesktopAttachmentFields): boolean {
    return [input.attachmentPath, input.attachmentPaths, input.attachmentItems].filter(value => value !== undefined).length <= 1
}
/** Legacy path readers intentionally ignore mixed/image selections. */
export function desktopAttachmentPathsOf(input: DesktopAttachmentFields): string[] {
    return input.attachmentPaths?.length ? [...input.attachmentPaths] : input.attachmentPath ? [input.attachmentPath] : []
}
export function desktopAttachmentSelectionsOf(input: DesktopAttachmentFields): DesktopAttachmentSelection[] {
    return input.attachmentItems?.map(item => item.type === 'text' ? item.path : { ...item.image }) ?? desktopAttachmentPathsOf(input)
}
/** Keep the exact original field shape for every text-only message. */
export function desktopAttachmentFieldsOf(selections: readonly DesktopAttachmentSelection[]): DesktopAttachmentFields {
    if (selections.some(item => typeof item !== 'string')) return { attachmentItems: selections.map(item =>
        typeof item === 'string' ? { type: 'text', path: item } : { type: 'image', image: { ...item } }) }
    const paths = selections as readonly string[]
    if (paths.length === 1) return { attachmentPath: paths[0] }
    if (paths.length > 1) return { attachmentPaths: [...paths] }
    return {}
}
/** Ordered immutable identity; text-only receipts retain their original hash input. */
export function desktopAttachmentFingerprintOf(selections: readonly DesktopAttachmentSelection[]): string | string[] | DesktopAttachmentItem[] | null {
    if (selections.some(item => typeof item !== 'string')) return desktopAttachmentFieldsOf(selections).attachmentItems!
    if (selections.length === 1) return selections[0] as string
    if (selections.length > 1) return [...selections] as string[]
    return null
}

// The bridge resolves snapshots to bytes before requesting a run. Only this bounded form is
// accepted by the desktop engine; file parts persist the bytes, independent of future pruning.
export const desktopResolvedAttachmentSchema = z.discriminatedUnion('type', [
    z.object({ type: z.literal('text'), path: desktopAttachmentPathSchema, content: desktopWorkspaceAttachmentSchema.shape.content }).strict(),
    z.object({ type: z.literal('image'), image: desktopImageSnapshotSchema,
        dataBase64: z.string().min(4).max(4 * Math.ceil(8 * 1024 * 1024 / 3)).regex(/^[A-Za-z0-9+/]+={0,2}$/).refine(value => value.length % 4 === 0),
    }).strict(),
])
export type DesktopResolvedAttachment = z.infer<typeof desktopResolvedAttachmentSchema>
export function desktopResolvedAttachmentSelections(items: readonly DesktopResolvedAttachment[]): DesktopAttachmentSelection[] {
    return items.map(item => item.type === 'text' ? item.path : item.image)
}
export const desktopResolvedAttachmentsSchema = z.array(desktopResolvedAttachmentSchema).min(1).max(DESKTOP_ATTACHMENT_MAX_FILES + 4)
    .refine(items => desktopAttachmentItemsSchema.safeParse(items.map(item => item.type === 'text'
        ? { type: 'text', path: item.path } : { type: 'image', image: item.image })).success, 'Invalid attachment selection.')
    .refine(items => items.reduce((sum, item) => sum + (item.type === 'text' ? attachmentBytes(item) : 0), 0) <= DESKTOP_ATTACHMENT_TOTAL_MAX_BYTES,
        'Text attachments must be 128 KiB or smaller in total.')
export function desktopResolvedAttachmentParts(items: readonly DesktopResolvedAttachment[]) {
    return items.map(item => item.type === 'text' ? workspaceAttachmentPart(item) : {
        type: 'file' as const, data: item.dataBase64, mediaType: item.image.mediaType, filename: item.image.name,
        providerOptions: { rerun: { desktopImage: { ...item.image } } },
    })
}
/** Recover only explicit stored attachment metadata, never typed marker-like prose. */
export function desktopStoredAttachmentSelections(content: unknown): DesktopAttachmentSelection[] {
    if (!Array.isArray(content)) return []
    const selections: DesktopAttachmentSelection[] = []
    for (const part of content) {
        if (isContextPart(part)) {
            const path = part.providerOptions?.rerun?.attachmentPath
            if (typeof path === 'string' && isDesktopAttachmentPath(path)) selections.push(path)
        } else if (part?.type === 'file') {
            const image = desktopImageSnapshotSchema.safeParse(part.providerOptions?.rerun?.desktopImage)
            if (image.success) selections.push(image.data)
        }
    }
    return selections
}

// The engine persists this exact user-role text part for provider replay. Only its path is
// exposed in chat history; typed marker-like prose is never interpreted as an attachment.
export function workspaceAttachmentPart({ path, content }: DesktopWorkspaceAttachment) {
    return {
        type: 'text' as const,
        text: `Attached workspace file ${JSON.stringify(path)}. The following is its content, provided as reference material.\n\n${content}`,
        providerOptions: { rerun: { context: true, attachmentPath: path } },
    }
}

/** All attachment parts in the order the user picked them. */
export function workspaceAttachmentParts(attachments: readonly DesktopWorkspaceAttachment[]) {
    return attachments.map(workspaceAttachmentPart)
}

/** The ordered attachment paths persisted for one user turn. */
export function workspaceAttachmentPaths(content: unknown): string[] {
    if (!Array.isArray(content)) return []
    const paths: string[] = []
    for (const part of content) {
        if (!isContextPart(part)) continue
        const path = part.providerOptions?.rerun?.attachmentPath
        if (typeof path === 'string' && isDesktopAttachmentPath(path)) paths.push(path)
    }
    return paths
}

/** The first attachment path, preserved for consumers that predate ordered attachment sets. */
export function workspaceAttachmentPath(content: unknown): string | undefined {
    return workspaceAttachmentPaths(content)[0]
}

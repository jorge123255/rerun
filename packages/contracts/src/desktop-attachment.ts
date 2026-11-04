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

/** The ordered paths a draft, queue item, or chat request carries, accepting the legacy single path. */
export type DesktopAttachmentFields = { attachmentPath?: string; attachmentPaths?: string[] }

export function desktopAttachmentPathsOf(input: DesktopAttachmentFields): string[] {
    return input.attachmentPaths?.length ? [...input.attachmentPaths] : input.attachmentPath ? [input.attachmentPath] : []
}

/**
 * One path keeps the original single-attachment field, so old rows, old receipts, and the
 * single-file API shape stay valid. Two or more use the ordered array.
 */
export function desktopAttachmentFieldsOf(paths: readonly string[]): DesktopAttachmentFields {
    if (paths.length === 1) return { attachmentPath: paths[0] }
    if (paths.length > 1) return { attachmentPaths: [...paths] }
    return {}
}

/** A stable value for idempotency fingerprints: one path hashes exactly like the old receipt. */
export function desktopAttachmentFingerprintOf(paths: readonly string[]): string | string[] | null {
    if (paths.length === 1) return paths[0]!
    if (paths.length > 1) return [...paths]
    return null
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

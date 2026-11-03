import { z } from 'zod'
import { isContextPart } from './chat-context.js'

export const DESKTOP_ATTACHMENT_MAX_BYTES = 32 * 1024

export function isDesktopAttachmentPath(path: string): boolean {
    return path.length <= 4096 && /\.(?:txt|md)$/i.test(path) && !/\p{Cc}/u.test(path)
        && path.split('/').every(segment => segment !== '' && segment !== '.' && segment !== '..')
}

export const desktopWorkspaceAttachmentSchema = z.object({
    path: z.string().refine(isDesktopAttachmentPath),
    content: z.string().max(DESKTOP_ATTACHMENT_MAX_BYTES).refine(value => new TextEncoder().encode(value).length <= DESKTOP_ATTACHMENT_MAX_BYTES),
})
export type DesktopWorkspaceAttachment = z.infer<typeof desktopWorkspaceAttachmentSchema>

// The engine persists this exact user-role text part for provider replay. Only its path is
// exposed in chat history; typed marker-like prose is never interpreted as an attachment.
export function workspaceAttachmentPart({ path, content }: DesktopWorkspaceAttachment) {
    return {
        type: 'text' as const,
        text: `Attached workspace file ${JSON.stringify(path)}. The following is its content, provided as reference material.\n\n${content}`,
        providerOptions: { rerun: { context: true, attachmentPath: path } },
    }
}

export function workspaceAttachmentPath(content: unknown): string | undefined {
    if (!Array.isArray(content)) return undefined
    for (const part of content) {
        if (!isContextPart(part)) continue
        const path = part.providerOptions?.rerun?.attachmentPath
        if (typeof path === 'string' && isDesktopAttachmentPath(path)) return path
    }
    return undefined
}

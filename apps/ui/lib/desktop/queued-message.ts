import { desktopCoworkerMentionsSchema, validDesktopCoworkerMentionFields } from '@rerun/contracts'
import { z } from 'zod'
import { desktopChatHasContent } from './chat-content'
import { appendAttachmentsRef, buildAttachmentsRef, desktopAttachmentPathsOf, desktopAttachmentSelectionsOf, type DesktopAttachmentSelection, desktopAttachmentItemsSchema, hasOneDesktopAttachmentField, desktopAttachmentPathsSchema, type DesktopAttachmentFields } from '@rerun/contracts'

export const desktopQueueScopeSchema = z.object({ sessionId: z.string().min(1).max(128).optional(), tabUid: z.string().min(1).max(128).optional() }).strict().refine(scope => !!(scope.sessionId || scope.tabUid))
export type DesktopQueueScope = z.infer<typeof desktopQueueScopeSchema>
export const desktopQueuedMessageSchema = z.object({
    id: z.string().uuid(), text: z.string().max(20_000),
    coworkerMentions: desktopCoworkerMentionsSchema.optional(),
    attachmentPath: z.string().min(1).max(4096).optional(),
    attachmentPaths: desktopAttachmentPathsSchema.optional(),
    attachmentItems: desktopAttachmentItemsSchema.optional(),
    createdAt: z.number().int().nonnegative(), behindRunId: z.string().min(1).nullable(),
    state: z.enum(['waiting', 'sending', 'review']),
}).strict().refine(hasOneDesktopAttachmentField, 'Use one attachment field.')
    .refine(desktopChatHasContent, 'Write a message or attach a file.').refine(validDesktopCoworkerMentionFields, 'Coworker mention ranges changed.')
export type DesktopQueuedMessage = z.infer<typeof desktopQueuedMessageSchema>
export const desktopQueueWriteSchema = z.discriminatedUnion('action', [
    z.object({ action: z.literal('enqueue'), scope: desktopQueueScopeSchema, expectedId: z.string().uuid().nullable(), item: desktopQueuedMessageSchema }).strict(),
    z.object({ action: z.enum(['attempt', 'review', 'remove']), scope: desktopQueueScopeSchema, id: z.string().uuid() }).strict(),
])
export type DesktopQueueWrite = z.infer<typeof desktopQueueWriteSchema>

/** Ordered paths of a queued message, accepting a queue item saved before ordered sets. */
export function desktopQueuedAttachmentPaths(item: DesktopAttachmentFields): string[] {
    return desktopAttachmentPathsOf(item)
}

export function desktopQueuedAttachmentSelections(item: DesktopAttachmentFields): DesktopAttachmentSelection[] {
    return desktopAttachmentSelectionsOf(item)
}

// Use Rerun's original pill/preview contract without sending its attachment marker to the Mac
// bridge: desktop attachments are separately validated and snapshotted on the engine.
export function desktopQueuedPreview(item: DesktopQueuedMessage): string {
    const paths = desktopQueuedAttachmentSelections(item).map(item => typeof item === 'string' ? item : item.path)
    return paths.length ? appendAttachmentsRef(item.text, buildAttachmentsRef(paths)) : item.text
}

import { z } from 'zod'
import { appendAttachmentsRef, buildAttachmentsRef } from '@rerun/contracts'

export const desktopQueueScopeSchema = z.object({ sessionId: z.string().min(1).max(128).optional(), tabUid: z.string().min(1).max(128).optional() }).strict().refine(scope => !!(scope.sessionId || scope.tabUid))
export type DesktopQueueScope = z.infer<typeof desktopQueueScopeSchema>
export const desktopQueuedMessageSchema = z.object({
    id: z.string().uuid(), text: z.string().trim().min(1).max(20_000),
    attachmentPath: z.string().min(1).max(4096).optional(),
    createdAt: z.number().int().nonnegative(), behindRunId: z.string().min(1).nullable(),
    state: z.enum(['waiting', 'sending', 'review']),
}).strict()
export type DesktopQueuedMessage = z.infer<typeof desktopQueuedMessageSchema>
export const desktopQueueWriteSchema = z.discriminatedUnion('action', [
    z.object({ action: z.literal('enqueue'), scope: desktopQueueScopeSchema, expectedId: z.string().uuid().nullable(), item: desktopQueuedMessageSchema }).strict(),
    z.object({ action: z.enum(['attempt', 'review', 'remove']), scope: desktopQueueScopeSchema, id: z.string().uuid() }).strict(),
])
export type DesktopQueueWrite = z.infer<typeof desktopQueueWriteSchema>

// Use Rerun's original pill/preview contract without sending its attachment marker to the Mac
// bridge: desktop attachments are separately validated and snapshotted on the engine.
export function desktopQueuedPreview(item: DesktopQueuedMessage): string {
    return item.attachmentPath ? appendAttachmentsRef(item.text, buildAttachmentsRef([item.attachmentPath])) : item.text
}

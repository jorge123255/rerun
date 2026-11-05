import { desktopModelPickSchema } from '@/lib/desktop/chat-model'
import { desktopChatHasContent } from '@/lib/desktop/chat-content'
import { desktopAttachmentItemsSchema, hasOneDesktopAttachmentField, desktopAttachmentPathsSchema } from '@rerun/contracts'
import { z } from 'zod'
import { DesktopHttpError } from '@/lib/desktop/server/auth'
import { startDesktopChat } from '@/lib/desktop/server/engine'
import { desktopRoute } from '@/lib/desktop/server/http'

const sendInput = z.object({
    agentId: z.string().min(1),
    sessionId: z.string().min(1).optional(),
    text: z.string().trim().max(20_000),
    attachmentPath: z.string().min(1).max(4096).optional(),
    attachmentPaths: desktopAttachmentPathsSchema.optional(),
    attachmentItems: desktopAttachmentItemsSchema.optional(),
    regenerateMessageId: z.never().optional(),
    requestId: z.string().uuid().optional(),
    reconcileOnly: z.boolean().optional(),
    modelChoice: desktopModelPickSchema.optional(),
    tabUid: z.string().min(1).max(128).optional(),
}).refine(hasOneDesktopAttachmentField, 'Use one attachment field.')
    .refine(desktopChatHasContent, 'Write a message or attach a file.')
    .refine(input => (!input.tabUid || !input.sessionId) && (!input.requestId || !!input.sessionId) && (!input.reconcileOnly || !!input.requestId))
const regenerateInput = z.object({
    agentId: z.string().min(1),
    sessionId: z.string().min(1),
    regenerateMessageId: z.string().regex(/^engine-[a-zA-Z0-9_-]{1,128}$/),
    requestId: z.string().uuid(),
}).strict()
const inputSchema = z.union([sendInput, regenerateInput])

export async function POST(request: Request): Promise<Response> {
    return desktopRoute(request, async runtime => {
        const parsed = inputSchema.safeParse(await request.json().catch(() => null))
        if (!parsed.success) throw new DesktopHttpError(400, 'Choose a saved reply to regenerate, write a message or attach a file.')
        return (await startDesktopChat(runtime, parsed.data)).response
    })
}

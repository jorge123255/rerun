import { desktopModelPickSchema } from '@/lib/desktop/chat-model'
import { z } from 'zod'
import { DesktopHttpError } from '@/lib/desktop/server/auth'
import { startDesktopChat } from '@/lib/desktop/server/engine'
import { desktopRoute } from '@/lib/desktop/server/http'

const sendInput = z.object({
    agentId: z.string().min(1),
    sessionId: z.string().min(1).optional(),
    text: z.string().trim().min(1).max(20_000),
    attachmentPath: z.string().min(1).max(4096).optional(),
    regenerateMessageId: z.never().optional(),
    requestId: z.never().optional(),
    modelChoice: desktopModelPickSchema.optional(),
})
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
        if (!parsed.success) throw new DesktopHttpError(400, 'Choose a saved reply to regenerate or enter a message to send.')
        return (await startDesktopChat(runtime, parsed.data)).response
    })
}

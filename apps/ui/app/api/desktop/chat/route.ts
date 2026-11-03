import { z } from 'zod'
import { DesktopHttpError } from '@/lib/desktop/server/auth'
import { startDesktopChat } from '@/lib/desktop/server/engine'
import { desktopRoute } from '@/lib/desktop/server/http'

const inputSchema = z.object({
    agentId: z.string().min(1),
    sessionId: z.string().min(1).optional(),
    text: z.string().trim().min(1).max(20_000),
    attachmentPath: z.string().min(1).max(4096).optional(),
})

export async function POST(request: Request): Promise<Response> {
    return desktopRoute(request, async runtime => {
        const parsed = inputSchema.safeParse(await request.json().catch(() => null))
        if (!parsed.success) throw new DesktopHttpError(400, 'A coworker and message text are required')
        return (await startDesktopChat(runtime, parsed.data)).response
    })
}

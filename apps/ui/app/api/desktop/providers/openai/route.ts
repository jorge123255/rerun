import { z } from 'zod'
import { DesktopHttpError } from '@/lib/desktop/server/auth'
import { connectDesktopOpenAI } from '@/lib/desktop/server/engine'
import { desktopRoute } from '@/lib/desktop/server/http'

const inputSchema = z.object({ apiKey: z.string().trim().min(1).max(4096) })

export async function POST(request: Request): Promise<Response> {
    return desktopRoute(request, async runtime => {
        const parsed = inputSchema.safeParse(await request.json().catch(() => null))
        if (!parsed.success) throw new DesktopHttpError(400, 'A valid OpenAI API key is required')
        const connection = await connectDesktopOpenAI(runtime, parsed.data.apiKey)
        return Response.json({ connection }, { status: 201 })
    })
}

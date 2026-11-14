import { z } from 'zod'
import { DesktopHttpError } from '@/lib/desktop/server/auth'
import { setDesktopModelEffort } from '@/lib/desktop/server/chat-model'
import { desktopRoute } from '@/lib/desktop/server/http'

export const dynamic = 'force-dynamic'

const id = z.string().trim().min(1).max(256)
const body = z.object({ connectionId: id, model: id, effort: z.string().trim().min(1).max(32).nullable() }).strict()

// One effort per model, chosen in a chat's model picker. `null` returns the model to its own default.
export function PUT(request: Request) {
    return desktopRoute(request, async runtime => {
        const change = body.safeParse(await request.json().catch(() => null))
        if (!change.success) throw new DesktopHttpError(400, 'Choose a reasoning effort this model offers.')
        return Response.json(await setDesktopModelEffort(runtime, change.data), { headers: { 'cache-control': 'no-store' } })
    })
}

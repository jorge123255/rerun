import { coworkerSettingsPatch } from '@/lib/desktop/coworker-settings'
import { DesktopHttpError } from '@/lib/desktop/server/auth'
import { desktopCoworkerSettings } from '@/lib/desktop/server/engine'
import { desktopRoute } from '@/lib/desktop/server/http'

type Context = { params: Promise<{ agentId: string }> }

export function GET(request: Request, { params }: Context) {
    return desktopRoute(request, async runtime => Response.json(await desktopCoworkerSettings(runtime, (await params).agentId)))
}

export function PATCH(request: Request, { params }: Context) {
    return desktopRoute(request, async runtime => {
        const patch = coworkerSettingsPatch.safeParse(await request.json().catch(() => null))
        if (!patch.success) throw new DesktopHttpError(400, 'Enter instructions or choose a valid reply length.')
        return Response.json(await desktopCoworkerSettings(runtime, (await params).agentId, patch.data))
    })
}

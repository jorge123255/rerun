import { settingsChange } from '@/lib/desktop/settings'
import { DesktopHttpError } from '@/lib/desktop/server/auth'
import { desktopRoute } from '@/lib/desktop/server/http'
import { changeDesktopSettings, readDesktopProviders } from '@/lib/desktop/server/settings'

export function GET(request: Request) {
    return desktopRoute(request, async runtime => Response.json(await readDesktopProviders(runtime)))
}

export async function PATCH(request: Request) {
    return desktopRoute(request, async runtime => {
        const parsed = settingsChange.safeParse(await request.json().catch(() => null))
        if (!parsed.success) throw new DesktopHttpError(400, 'Check the provider, model, or workspace name and try again.')
        await changeDesktopSettings(runtime, parsed.data)
        return Response.json(await readDesktopProviders(runtime))
    })
}

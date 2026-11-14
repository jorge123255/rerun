import { z } from 'zod'
import { desktopProfileName } from '@/lib/desktop/local-profile'
import { DesktopHttpError } from '@/lib/desktop/server/auth'
import { desktopRoute } from '@/lib/desktop/server/http'
import { desktopProfileDatabase, readDesktopProfile, updateDesktopProfileName } from '@/lib/desktop/server/local-profile'
import { readDesktopJson } from '@/lib/desktop/server/request-json'

const input = z.strictObject({ name: desktopProfileName })

export function GET(request: Request) {
    return desktopRoute(request, async runtime =>
        Response.json(await readDesktopProfile(await desktopProfileDatabase(runtime)), { headers: { 'cache-control': 'no-store' } }))
}

export function PUT(request: Request) {
    return desktopRoute(request, async runtime => {
        const parsed = input.safeParse(await readDesktopJson(request, 4096))
        if (!parsed.success) throw new DesktopHttpError(400, 'Enter a display name between 1 and 80 characters.')
        const profile = await updateDesktopProfileName(runtime, parsed.data.name, request.signal)
        return Response.json(profile, { headers: { 'cache-control': 'no-store' } })
    })
}

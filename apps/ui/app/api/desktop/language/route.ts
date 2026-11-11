import { LOCALES } from '@rerun/i18n'
import { z } from 'zod'
import { DesktopHttpError } from '@/lib/desktop/server/auth'
import { desktopRoute } from '@/lib/desktop/server/http'
import { saveDesktopLanguage } from '@/lib/desktop/server/language'

const input = z.strictObject({ preference: z.enum(LOCALES).nullable() })

export function PUT(request: Request) {
    return desktopRoute(request, async runtime => {
        const parsed = input.safeParse(await request.json().catch(() => null))
        if (!parsed.success) throw new DesktopHttpError(400, 'Choose a supported language.')
        const language = await saveDesktopLanguage(runtime, parsed.data.preference, request.headers.get('accept-language'))
        return Response.json(language, { headers: { 'cache-control': 'no-store' } })
    })
}

import { foremanAlternateRunRequestSchema } from '@rerun/contracts'
import { DesktopHttpError } from '@/lib/desktop/server/auth'
import { changeForemanAlternateRun } from '@/lib/desktop/server/foreman-alternates/binding'
import { desktopRoute } from '@/lib/desktop/server/http'
import { readDesktopJson } from '@/lib/desktop/server/request-json'

export const runtime = 'nodejs'

export function POST(request: Request) {
    return desktopRoute(request, async runtime => {
        const parsed = foremanAlternateRunRequestSchema.safeParse(await readDesktopJson(request, 4096))
        if (!parsed.success) throw new DesktopHttpError(400, 'Invalid Chief of Staff retry request.')
        return Response.json(await changeForemanAlternateRun(runtime, parsed.data, request.signal), {
            headers: { 'cache-control': 'no-store' },
        })
    })
}

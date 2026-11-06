import { desktopRoute } from '@/lib/desktop/server/http'
import { openDesktopPortableServer, readPortableRequest } from '@/lib/desktop/server/templates/portable-runtime'
import { DesktopHttpError } from '@/lib/desktop/server/auth'
export const dynamic = 'force-dynamic'
export function GET(request: Request) {
    return desktopRoute(request, async runtime => Response.json({ pending: await (await openDesktopPortableServer(runtime, request.signal)).pendingImport() }, { headers: { 'cache-control': 'no-store' } }))
}
export function POST(request: Request) {
    return desktopRoute(request, async runtime => {
        const parsed = await readPortableRequest(request)
        return Response.json(await (await openDesktopPortableServer(runtime, request.signal)).prepare(parsed), { headers: { 'cache-control': 'no-store' } })
    })
}
export function DELETE(request: Request) {
    return desktopRoute(request, async runtime => {
        const input = await readPortableRequest(request)
        if (!input || typeof input !== 'object' || Object.keys(input).length !== 1 || !('requestId' in input)) throw new DesktopHttpError(400, 'Invalid template acknowledgement')
        return Response.json(await (await openDesktopPortableServer(runtime, request.signal)).acknowledge(input.requestId), { headers: { 'cache-control': 'no-store' } })
    })
}

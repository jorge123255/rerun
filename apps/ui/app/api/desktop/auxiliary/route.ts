import { desktopRoute } from '@/lib/desktop/server/http'
import { openDesktopDatabase } from '@/lib/desktop/server/database'
import { desktopAuxiliaryStore } from '@/lib/desktop/server/auxiliary/store'
import { boundedText } from '@/lib/desktop/server/mcp/remote'

export function GET(request: Request) {
    return desktopRoute(request, async runtime => Response.json(await desktopAuxiliaryStore(await openDesktopDatabase(runtime.dataRoot)).list(), { headers: { 'Cache-Control': 'no-store' } }))
}
export function PATCH(request: Request) {
    return desktopRoute(request, async runtime => {
        const store = desktopAuxiliaryStore(await openDesktopDatabase(runtime.dataRoot))
        try { await store.change(JSON.parse(await boundedText(new Response(request.body), request.signal, 12_000))) }
        catch { return Response.json({ error: 'Could not save this key. Reload the saved settings before trying again.' }, { status: 409 }) }
        return Response.json(await store.list(), { headers: { 'Cache-Control': 'no-store' } })
    })
}

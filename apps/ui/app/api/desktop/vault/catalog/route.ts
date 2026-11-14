import { desktopRoute } from '@/lib/desktop/server/http'
import { vaultCatalog } from '@/lib/desktop/server/vault/catalog'

export const dynamic = 'force-dynamic'

export function GET(request: Request) {
    return desktopRoute(request, async () => {
        const query = new URL(request.url).searchParams.get('q')?.slice(0, 128) ?? ''
        return Response.json(vaultCatalog(query), { headers: { 'cache-control': 'no-store' } })
    })
}

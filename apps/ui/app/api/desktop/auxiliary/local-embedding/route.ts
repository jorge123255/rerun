import { desktopRoute } from '@/lib/desktop/server/http'
import { desktopLocalEmbeddingStatus } from '@/lib/desktop/server/auxiliary/local-embedding'

export const dynamic = 'force-dynamic'

// Whether Ollama answers on this Mac and which models it has. Asks this machine only.
export function GET(request: Request) {
    return desktopRoute(request, async () => Response.json(await desktopLocalEmbeddingStatus(request.signal), { headers: { 'Cache-Control': 'no-store' } }))
}

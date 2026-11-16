import { z } from 'zod'
import { DESKTOP_LOCAL_EMBEDDING_DOWNLOADS } from '@/lib/desktop/auxiliary'
import { DesktopHttpError } from '@/lib/desktop/server/auth'
import { desktopRoute } from '@/lib/desktop/server/http'
import { desktopLocalEmbeddingDownload, desktopLocalEmbeddingStatus, startDesktopLocalEmbeddingDownload } from '@/lib/desktop/server/auxiliary/local-embedding'
import { readDesktopJson } from '@/lib/desktop/server/request-json'

export const dynamic = 'force-dynamic'
const headers = { 'Cache-Control': 'no-store' }
const input = z.strictObject({ action: z.literal('download'), model: z.enum(DESKTOP_LOCAL_EMBEDDING_DOWNLOADS) })

// Whether Ollama answers on this Mac, which models it has, and how far a download has come. Asks this machine only.
export function GET(request: Request) {
    return desktopRoute(request, async () => Response.json({ ...await desktopLocalEmbeddingStatus(request.signal), download: desktopLocalEmbeddingDownload() }, { headers }))
}

// Asks Ollama to download one of the offered embedding models.
export function POST(request: Request) {
    return desktopRoute(request, async () => {
        const parsed = input.safeParse(await readDesktopJson(request, 2_000))
        if (!parsed.success) throw new DesktopHttpError(400, 'Choose one of the offered models.')
        startDesktopLocalEmbeddingDownload(parsed.data.model)
        return Response.json({ ...await desktopLocalEmbeddingStatus(request.signal), download: desktopLocalEmbeddingDownload() }, { headers })
    })
}

import { desktopAuxiliaryStore } from '@/lib/desktop/server/auxiliary/store'
import { openDesktopDatabase } from '@/lib/desktop/server/database'
import { desktopRoute } from '@/lib/desktop/server/http'
import { desktopSpeechService } from '@/lib/desktop/server/speech'

export const dynamic = 'force-dynamic'

// The voices of the owner's ElevenLabs account, asked for with the saved key and kept while the app runs.
export function GET(request: Request) {
    return desktopRoute(request, async runtime => {
        const store = desktopAuxiliaryStore(await openDesktopDatabase(runtime.dataRoot))
        const voices = await desktopSpeechService(store).voices(AbortSignal.any([request.signal, AbortSignal.timeout(20_000)]))
        return Response.json({ voices }, { headers: { 'Cache-Control': 'no-store' } })
    })
}

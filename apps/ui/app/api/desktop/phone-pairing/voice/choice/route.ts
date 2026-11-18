import { z } from 'zod'
import { desktopSpeechVoiceId } from '@/lib/desktop/speech'
import { DesktopHttpError } from '@/lib/desktop/server/auth'
import { desktopAuxiliaryStore } from '@/lib/desktop/server/auxiliary/store'
import { openDesktopDatabase } from '@/lib/desktop/server/database'
import { desktopRoute } from '@/lib/desktop/server/http'
import { readDesktopJson } from '@/lib/desktop/server/request-json'
import type { DesktopRuntime } from '@/lib/desktop/server/runtime'
import { changeDesktopSpeechSettings, desktopSpeechService, readDesktopSpeechSettings } from '@/lib/desktop/server/speech'
import { desktopVoiceEngineStore } from '@/lib/desktop/server/voice-engine/store'

export const dynamic = 'force-dynamic'
const headers = { 'cache-control': 'no-store' }
const choice = z.strictObject({ voiceId: desktopSpeechVoiceId })

// The pairing bridge holds the device grant during a write. Expose only voice names from the
// enabled workspace. The ElevenLabs key and all other speech preferences stay on the Mac.
async function catalog(runtime: DesktopRuntime, signal: AbortSignal) {
    const db = await openDesktopDatabase(runtime.dataRoot)
    if (!(await desktopVoiceEngineStore(db).read()).enabled) throw new DesktopHttpError(404, 'Not found')
    const store = desktopAuxiliaryStore(db)
    const voices = await desktopSpeechService(store).voices(AbortSignal.any([signal, AbortSignal.timeout(7_500)]))
    return { db, store, voices: voices.map(({ id, name }) => ({ id, name })) }
}

export function GET(request: Request) {
    return desktopRoute(request, async runtime => {
        const { db, store, voices } = await catalog(runtime, request.signal)
        const { voiceId } = await readDesktopSpeechSettings(db, store)
        return Response.json({ voiceId, voices }, { headers })
    })
}

export function POST(request: Request) {
    return desktopRoute(request, async runtime => {
        const picked = choice.safeParse(await readDesktopJson(request, 256))
        if (!picked.success) throw new DesktopHttpError(400, 'Choose a voice.')
        const { db, voices } = await catalog(runtime, request.signal)
        if (!voices.some(voice => voice.id === picked.data.voiceId)) throw new DesktopHttpError(400, 'Choose an available voice.')
        await changeDesktopSpeechSettings(db, picked.data)
        return Response.json({ voiceId: picked.data.voiceId }, { headers })
    })
}

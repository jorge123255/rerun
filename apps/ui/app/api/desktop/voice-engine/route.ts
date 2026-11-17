import { desktopVoiceEngineActionSchema } from '@/lib/desktop/voice-engine'
import { DesktopHttpError } from '@/lib/desktop/server/auth'
import { desktopRoute } from '@/lib/desktop/server/http'
import { readDesktopJson } from '@/lib/desktop/server/request-json'
import { desktopVoiceEngine } from '@/lib/desktop/server/voice-engine/binding'

export const dynamic = 'force-dynamic'
const noStore = { 'Cache-Control': 'no-store' }

// Talking to the Chief of Staff from a paired phone: the relay address, the engine, the switch and
// whether the relay is connected. The relay's id and secret are in a reply once, when they are made.
// Never the ElevenLabs key or its hash.
export function GET(request: Request) {
    return desktopRoute(request, async runtime => Response.json({ status: await (await desktopVoiceEngine(runtime)).status() }, { headers: noStore }))
}

export function POST(request: Request) {
    return desktopRoute(request, async runtime => {
        const parsed = desktopVoiceEngineActionSchema.safeParse(await readDesktopJson(request, 4_000))
        if (!parsed.success) throw new DesktopHttpError(400, 'This voice setting was not understood.')
        const service = await desktopVoiceEngine(runtime), input = parsed.data
        const reply = input.action === 'relay' ? await service.saveRelay(input.relayOrigin)
            : input.action === 'rotate' ? await service.rotate()
            : input.action === 'create-engine' ? await service.createEngine(AbortSignal.any([request.signal, AbortSignal.timeout(30_000)]))
            : input.action === 'enabled' ? await service.setEnabled(input.enabled)
            : await service.forget()
        return Response.json(reply, { headers: noStore })
    })
}

import { foremanChatIdSchema } from '@rerun/contracts'
import { z } from 'zod'
import { DesktopHttpError } from '@/lib/desktop/server/auth'
import { desktopRoute } from '@/lib/desktop/server/http'
import { readDesktopJson } from '@/lib/desktop/server/request-json'
import { desktopVoiceEngine } from '@/lib/desktop/server/voice-engine/binding'

export const dynamic = 'force-dynamic'
const input = z.strictObject({ chatId: foremanChatIdSchema })

// For the pairing service, on behalf of a phone allowed to send messages: a short-lived ElevenLabs
// token for one voice conversation on the Chief of Staff conversation the phone names. The reply is
// the token, its conversation id and when it lapses, and nothing else. Off, it does not exist.
export function POST(request: Request) {
    return desktopRoute(request, async runtime => {
        const parsed = input.safeParse(await readDesktopJson(request, 1_000))
        if (!parsed.success) throw new DesktopHttpError(400, 'Name the conversation.')
        const service = await desktopVoiceEngine(runtime)
        const grant = await service.startConversation({ workspaceId: String(runtime.workspaceId), chatId: parsed.data.chatId }, AbortSignal.any([request.signal, AbortSignal.timeout(8_000)]))
        return Response.json({ conversationToken: grant.conversationToken, conversationId: grant.conversationId, expiresAt: grant.expiresAt }, { headers: { 'cache-control': 'no-store' } })
    })
}

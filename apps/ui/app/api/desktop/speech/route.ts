import { DESKTOP_SPEECH_PREVIEW_SENTENCE, desktopSpeechRequestSchema } from '@/lib/desktop/speech'
import { DesktopHttpError } from '@/lib/desktop/server/auth'
import { desktopAuxiliaryStore } from '@/lib/desktop/server/auxiliary/store'
import { openDesktopDatabase } from '@/lib/desktop/server/database'
import { desktopRoute } from '@/lib/desktop/server/http'
import { readDesktopJson } from '@/lib/desktop/server/request-json'
import { desktopForeman } from '@/lib/desktop/server/foreman/binding'
import type { DesktopRuntime } from '@/lib/desktop/server/runtime'
import { changeDesktopSpeechSettings, desktopSpeechOfSaved, desktopSpeechReplyText, desktopSpeechService, readDesktopSpeechSettings } from '@/lib/desktop/server/speech'

export const dynamic = 'force-dynamic'
const noStore = { 'Cache-Control': 'no-store' }

// Whether replies can be read aloud here, the chosen voice, and the automatic switch. Never the key.
export function GET(request: Request) {
    return desktopRoute(request, async runtime => {
        const db = await openDesktopDatabase(runtime.dataRoot)
        return Response.json(await readDesktopSpeechSettings(db, desktopAuxiliaryStore(db)), { headers: noStore })
    })
}

export function PUT(request: Request) {
    return desktopRoute(request, async runtime => {
        const db = await openDesktopDatabase(runtime.dataRoot)
        await changeDesktopSpeechSettings(db, await readDesktopJson(request, 2_000))
        return Response.json(await readDesktopSpeechSettings(db, desktopAuxiliaryStore(db)), { headers: noStore })
    })
}

// A saved answer of the Chief of Staff, read the way its thumbs are checked: from the conversation this workspace owns.
async function foremanReplyText(runtime: DesktopRuntime, chat: { workspaceId: string; chatId: string }, messageId: string) {
    const app = await desktopForeman(runtime)
    let state
    try { state = await app.state(chat) } catch (error) {
        if (error instanceof DesktopHttpError && error.status === 404) throw new DesktopHttpError(404, 'Conversation not found')
        throw new DesktopHttpError(502, 'This reply could not be loaded. Try again.')
    }
    if (state.chat.workspaceId !== chat.workspaceId || state.chat.chatId !== chat.chatId) throw new DesktopHttpError(404, 'Conversation not found')
    return desktopSpeechOfSaved(state.messages, messageId)
}

// Speaks one saved reply, or the fixed preview sentence. The renderer names a reply and never sends
// the words: they are read from the saved conversation, shortened, and sent to ElevenLabs with the
// key read here. The reply's text leaves this Mac and is billed to the owner's ElevenLabs account.
export function POST(request: Request) {
    return desktopRoute(request, async runtime => {
        const parsed = desktopSpeechRequestSchema.safeParse(await readDesktopJson(request, 2_000))
        if (!parsed.success) throw new DesktopHttpError(400, 'Name the reply to read aloud.')
        const db = await openDesktopDatabase(runtime.dataRoot)
        const store = desktopAuxiliaryStore(db)
        const signal = AbortSignal.any([request.signal, AbortSignal.timeout(120_000)])
        const spoken = 'preview' in parsed.data ? { text: DESKTOP_SPEECH_PREVIEW_SENTENCE, truncated: false }
            : 'foreman' in parsed.data ? await foremanReplyText(runtime, parsed.data.foreman, parsed.data.messageId)
            : await desktopSpeechReplyText(db, runtime, parsed.data, signal)
        const { voiceId } = await readDesktopSpeechSettings(db, store)
        const audio = await desktopSpeechService(store).speak(spoken.text, voiceId, signal)
        return new Response(audio, {
            headers: {
                ...noStore, 'Content-Type': 'audio/mpeg', 'X-Content-Type-Options': 'nosniff', 'Content-Disposition': 'inline',
                'X-Rerun-Speech-Truncated': spoken.truncated ? '1' : '0', 'X-Rerun-Speech-Characters': String(spoken.text.length),
            },
        })
    })
}

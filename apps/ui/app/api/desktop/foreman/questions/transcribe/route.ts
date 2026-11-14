import { foremanChatRefSchema } from '@rerun/contracts'
import { DesktopHttpError } from '@/lib/desktop/server/auth'
import { requirePendingForemanDictation } from '@/lib/desktop/server/foreman/question'
import { desktopRoute } from '@/lib/desktop/server/http'
import { readDesktopJson } from '@/lib/desktop/server/request-json'
import { DESKTOP_QUESTION_VOICE_BODY_BYTES, desktopQuestionVoiceInputSchema, transcribeDesktopQuestion } from '@/lib/desktop/server/voice/question-transcription'

const inputSchema = desktopQuestionVoiceInputSchema.extend({ chat: foremanChatRefSchema })

export function POST(request: Request) {
    return desktopRoute(request, async runtime => {
        const input = inputSchema.safeParse(await readDesktopJson(request, DESKTOP_QUESTION_VOICE_BODY_BYTES))
        if (!input.success) throw new DesktopHttpError(400, 'Send a supported voice recording for this question.')
        const { chat, questionId } = input.data
        return transcribeDesktopQuestion(input.data, request.signal, signal => requirePendingForemanDictation(runtime, chat, questionId, signal))
    })
}

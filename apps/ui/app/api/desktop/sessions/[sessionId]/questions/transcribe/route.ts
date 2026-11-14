import { DesktopHttpError } from '@/lib/desktop/server/auth'
import { desktopRoute } from '@/lib/desktop/server/http'
import { requireDesktopPendingQuestion } from '@/lib/desktop/server/questions'
import { readDesktopJson } from '@/lib/desktop/server/request-json'
import { DESKTOP_QUESTION_VOICE_BODY_BYTES, desktopQuestionVoiceInputSchema, transcribeDesktopQuestion } from '@/lib/desktop/server/voice/question-transcription'

export function POST(request: Request, context: { params: Promise<{ sessionId: string }> }) {
    return desktopRoute(request, async runtime => {
        const input = desktopQuestionVoiceInputSchema.safeParse(await readDesktopJson(request, DESKTOP_QUESTION_VOICE_BODY_BYTES))
        if (!input.success) throw new DesktopHttpError(400, 'Send a supported voice recording for this question.')
        const { sessionId } = await context.params
        return transcribeDesktopQuestion(input.data, request.signal, async signal => {
            const target = await requireDesktopPendingQuestion(runtime, sessionId, input.data.questionId, signal)
            return { db: target.db, identity: JSON.stringify([target.agent.engineAgentId, target.session.engineSessionId]) }
        })
    })
}

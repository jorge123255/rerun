import { DESKTOP_VOICE_MAX_BYTES, desktopVoiceUploadSchema } from '@rerun/contracts'
import { z } from 'zod'
import { DesktopHttpError } from '@/lib/desktop/server/auth'
import { desktopAuxiliaryBackends } from '@/lib/desktop/server/auxiliary/backends'
import { desktopAuxiliaryStore } from '@/lib/desktop/server/auxiliary/store'
import { desktopRoute } from '@/lib/desktop/server/http'
import { requireDesktopPendingQuestion } from '@/lib/desktop/server/questions'
import { readDesktopJson } from '@/lib/desktop/server/request-json'
import { decodeDesktopVoiceAudio, inspectDesktopVoiceBytes } from '@/lib/desktop/server/voice/bytes'

const inputSchema = desktopVoiceUploadSchema.pick({ format: true, durationMs: true, levels: true, audioBase64: true })
    .extend({ questionId: z.string().regex(/^[a-f0-9]{64}$/) })
const MAX_BODY_BYTES = Math.ceil(DESKTOP_VOICE_MAX_BYTES / 3) * 4 + 100_000

export function POST(request: Request, context: { params: Promise<{ sessionId: string }> }) {
    return desktopRoute(request, async runtime => {
        const input = inputSchema.safeParse(await readDesktopJson(request, MAX_BODY_BYTES))
        if (!input.success) throw new DesktopHttpError(400, 'Send a supported voice recording for this question.')
        const { questionId, audioBase64, format, durationMs, levels } = input.data
        const bytes = decodeDesktopVoiceAudio(audioBase64)
        inspectDesktopVoiceBytes(format, bytes, { durationMs, levels })
        const { sessionId } = await context.params
        const signal = AbortSignal.any([request.signal, AbortSignal.timeout(30_000)])
        const target = await requireDesktopPendingQuestion(runtime, sessionId, questionId, signal)
        const store = desktopAuxiliaryStore(target.db)
        if (!(await store.list()).some(item => item.purpose === 'transcription' && item.configured)) {
            throw new DesktopHttpError(503, 'Configure voice transcription in Settings to use a voice answer.')
        }
        // Dictation produces editable text only. No voice draft, question receipt, or chat turn is written.
        let transcript: string
        try {
            transcript = await desktopAuxiliaryBackends(store).transcribe(bytes, format.transcriptionFormat, signal)
        } catch {
            throw new DesktopHttpError(502, 'Could not transcribe this recording. Record again or type your answer.')
        }
        const current = await requireDesktopPendingQuestion(runtime, sessionId, questionId, signal)
        if (current.agent.engineAgentId !== target.agent.engineAgentId || current.session.engineSessionId !== target.session.engineSessionId) {
            throw new DesktopHttpError(409, 'This question is no longer available for a voice answer.')
        }
        if (!transcript) throw new DesktopHttpError(422, 'No speech was recognized. Try recording again.')
        return Response.json({ transcript: transcript.slice(0, 20_000) }, { headers: { 'cache-control': 'no-store' } })
    })
}

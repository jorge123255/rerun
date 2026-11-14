import 'server-only'
import type { Client } from '@libsql/client'
import { DESKTOP_VOICE_MAX_BYTES, desktopVoiceUploadSchema } from '@rerun/contracts'
import { z } from 'zod'
import { DesktopHttpError } from '../auth'
import { desktopAuxiliaryBackends } from '../auxiliary/backends'
import { desktopAuxiliaryStore } from '../auxiliary/store'
import { decodeDesktopVoiceAudio, inspectDesktopVoiceBytes } from './bytes'

export const desktopQuestionVoiceInputSchema = desktopVoiceUploadSchema.pick({ format: true, durationMs: true, levels: true, audioBase64: true })
    .extend({ questionId: z.string().regex(/^[a-f0-9]{64}$/) })
export const DESKTOP_QUESTION_VOICE_BODY_BYTES = Math.ceil(DESKTOP_VOICE_MAX_BYTES / 3) * 4 + 100_000

export async function transcribeDesktopQuestion(input: z.infer<typeof desktopQuestionVoiceInputSchema>, requestSignal: AbortSignal,
    requirePending: (signal: AbortSignal) => Promise<{ db: Client; identity: string }>) {
    const { audioBase64, format, durationMs, levels } = input
    const bytes = decodeDesktopVoiceAudio(audioBase64)
    inspectDesktopVoiceBytes(format, bytes, { durationMs, levels })
    const signal = AbortSignal.any([requestSignal, AbortSignal.timeout(30_000)])
    const target = await requirePending(signal)
    const store = desktopAuxiliaryStore(target.db)
    if (!(await store.list()).some(item => item.purpose === 'transcription' && item.configured)) {
        throw new DesktopHttpError(503, 'Configure voice transcription in Settings to use a voice answer.')
    }
    // Dictation yields editable text. Only the explicit question answer can start a turn.
    signal.throwIfAborted()
    let transcript: string
    try {
        transcript = await desktopAuxiliaryBackends(store).transcribe(bytes, format.transcriptionFormat, signal)
    } catch {
        throw new DesktopHttpError(502, 'Could not transcribe this recording. Record again or type your answer.')
    }
    const current = await requirePending(signal)
    if (current.identity !== target.identity) throw new DesktopHttpError(409, 'This question is no longer available for a voice answer.')
    if (!transcript) throw new DesktopHttpError(422, 'No speech was recognized. Try recording again.')
    return Response.json({ transcript: transcript.slice(0, 20_000) }, { headers: { 'cache-control': 'no-store' } })
}

import 'server-only'

import { z } from 'zod'
import { DESKTOP_VOICE_MAX_BYTES, desktopVoiceUploadSchema, desktopVoiceRevisionActionSchema, type DesktopVoiceScope } from '@rerun/contracts'
import { DesktopHttpError } from '../auth'
import { desktopRoute } from '../http'
import type { DesktopVoiceService } from './service'
import { decodeDesktopVoiceAudio } from './bytes'

const MAX_BODY_BYTES = Math.ceil(DESKTOP_VOICE_MAX_BYTES / 3) * 4 + 100_000
const scopeInput = z.object({ tabUid: z.string().min(1).max(128), sessionId: z.string().min(1).max(200).optional() }).strict()
const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }

function withDeadline<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const onAbort = () => reject(new Error('Voice request deadline exceeded'))
        signal.addEventListener('abort', onAbort, { once: true })
        work.then(value => {
            signal.removeEventListener('abort', onAbort)
            resolve(value)
        }, error => {
            signal.removeEventListener('abort', onAbort)
            reject(error)
        })
        if (signal.aborted) onAbort()
    })
}

async function readJson(request: Request, signal: AbortSignal): Promise<Record<string, unknown>> {
    const reader = request.body?.getReader()
    if (!reader) throw new DesktopHttpError(400, 'Missing voice request body.')
    const chunks: Uint8Array[] = []
    let size = 0
    try {
        while (true) {
            const part = await withDeadline(reader.read(), signal)
            if (part.done) break
            size += part.value.byteLength
            if (size > MAX_BODY_BYTES) throw new DesktopHttpError(413, 'Voice request exceeds its limit.')
            chunks.push(part.value)
        }
    } finally {
        await reader.cancel().catch(() => {})
    }
    const bytes = new Uint8Array(size)
    let offset = 0
    for (const chunk of chunks) {
        bytes.set(chunk, offset)
        offset += chunk.byteLength
    }
    return JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>
}

function scopeOf(agentId: string, body: unknown): DesktopVoiceScope {
    const input = scopeInput.parse(body)
    return { agentId, ...input }
}

export function desktopVoiceApi(service: DesktopVoiceService) {
    return async (request: Request, agentId: string): Promise<Response> => {
        const signal = AbortSignal.any([request.signal, AbortSignal.timeout(30_000)])
        try {
            if (request.method === 'GET') {
                const url = new URL(request.url)
                const tabUid = url.searchParams.get('tabUid')
                if (!tabUid) throw new DesktopHttpError(400, 'Choose a conversation tab.')
                const attemptId = url.searchParams.get('attemptId')
                const scope = scopeOf(agentId, { tabUid, sessionId: url.searchParams.get('sessionId') ?? undefined })
                if (attemptId && url.searchParams.get('view') === 'audio') {
                    const audio = await withDeadline(service.audio(scope, attemptId, signal), signal)
                    return new Response(new Uint8Array(audio.bytes).buffer, { headers: { ...headers, 'Content-Type': audio.mimeType, 'Content-Length': String(audio.bytes.byteLength) } })
                }
                if (attemptId) return Response.json({ draft: await withDeadline(service.draft(scope, attemptId, signal), signal) }, { headers })
                return Response.json({ drafts: await withDeadline(service.list(scope, signal), signal) }, { headers })
            }
            if (request.method !== 'POST') return Response.json({ error: 'Method unavailable.' }, { status: 405, headers })
            const body = await readJson(request, signal)
            const parsed = body.operation === 'upload' ? desktopVoiceUploadSchema.parse(body) : desktopVoiceRevisionActionSchema.parse(body)
            if (parsed.agentId !== agentId) throw new DesktopHttpError(409, 'Voice recording belongs to another coworker.')
            const scope = scopeOf(agentId, { tabUid: parsed.tabUid, sessionId: parsed.sessionId })
            switch (parsed.operation) {
                case 'upload': {
                    const { operation: _operation, audioBase64, ...input } = parsed
                    const bytes = decodeDesktopVoiceAudio(audioBase64)
                    const draft = await withDeadline(service.upload(scope, input, bytes, signal), signal)
                    return Response.json({ draft }, { headers })
                }
                case 'transcribe': {
                    const { operation: _operation, ...input } = parsed
                    return Response.json({ draft: await withDeadline(service.transcribe(scope, input, signal), signal) }, { headers })
                }
                case 'send': {
                    const { operation: _operation, ...input } = parsed
                    return Response.json(await withDeadline(service.send(scope, input, signal), signal), { headers })
                }
                case 'discard': {
                    const { operation: _operation, ...input } = parsed
                    await withDeadline(service.discard(scope, input, signal), signal)
                    return Response.json({ discarded: true }, { headers })
                }
                default:
                    throw new DesktopHttpError(400, 'Unknown voice operation.')
            }
        } catch (error) {
            if (error instanceof DesktopHttpError) throw error
            return Response.json({ error: 'Voice request failed or changed. Retry the same attempt.' }, { status: 400, headers })
        }
    }
}

export function desktopVoiceHandlers(service: DesktopVoiceService) {
    const api = desktopVoiceApi(service)
    const handler = async (request: Request, context: { params: Promise<{ agentId: string }> }) => desktopRoute(request, async () => api(request, (await context.params).agentId))
    return { GET: handler, POST: handler }
}

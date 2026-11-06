'use client'
import {
    foremanVoiceSnapshotSchema, sameForemanVoiceTarget,
    type ForemanVoiceRequest, type ForemanVoiceTarget,
} from '@rerun/contracts'
export function createForemanVoiceClient(fetcher: typeof fetch = fetch) {
    async function readSnapshot(response: Response, target: ForemanVoiceTarget, signal: AbortSignal, deadline: AbortSignal, attemptId?: string) {
        const reader = response.body?.getReader()
        if (!reader) throw Error('Foreman voice acknowledgement unavailable.')
        let bytes = 0
        const chunks: Uint8Array[] = [], abort = () => { void reader.cancel().catch(() => {}) }
        deadline.addEventListener('abort', abort, { once: true })
        try {
            for (;;) {
                deadline.throwIfAborted()
                const next = await reader.read()
                deadline.throwIfAborted()
                if (next.done) break
                bytes += next.value.length
                if (bytes > 400_000) throw Error('Foreman voice response exceeds its limit.')
                chunks.push(next.value)
            }
        } finally { deadline.removeEventListener('abort', abort); void reader.cancel().catch(() => {}) }
        const merged = new Uint8Array(bytes)
        let offset = 0
        for (const part of chunks) { merged.set(part, offset); offset += part.length }
        if (!response.ok) throw Error('Foreman voice acknowledgement unavailable. Refresh this same attempt.')
        const result = foremanVoiceSnapshotSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(merged)))
        if (!sameForemanVoiceTarget(result.target, target) || attemptId && (result.attempt && result.attempt.attemptId !== attemptId || result.receipt && result.receipt.attemptId !== attemptId)) throw Error('Foreman acknowledged another recording.')
        signal.throwIfAborted()
        return result
    }
    return {
        async request(input: ForemanVoiceRequest, signal: AbortSignal) {
            const deadline = AbortSignal.any([signal, AbortSignal.timeout(125_000)])
            const response = await fetcher('/api/desktop/foreman/voice', {
                method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input), signal: deadline, cache: 'no-store',
            })
            return readSnapshot(response, input.target, signal, deadline, input.attemptId)
        },
        async recover(target: ForemanVoiceTarget, signal: AbortSignal) {
            const deadline = AbortSignal.any([signal, AbortSignal.timeout(15_000)])
            const response = await fetcher(`/api/desktop/foreman/voice?${targetQuery(target, 'pending')}`, { signal: deadline, cache: 'no-store' })
            return readSnapshot(response, target, signal, deadline)
        },
    }
}
function targetQuery(target: ForemanVoiceTarget, view: 'audio' | 'pending') {
    return new URLSearchParams({ workspaceId: target.chat.workspaceId, chatId: target.chat.chatId, connectionId: target.model.connectionId, model: target.model.model, view })
}
export function foremanVoiceAudioUrl(target: ForemanVoiceTarget, attemptId: string) {
    const query = targetQuery(target, 'audio'); query.set('attemptId', attemptId)
    return `/api/desktop/foreman/voice?${query}`
}
export async function audioBase64(blob: Blob) {
    const bytes = new Uint8Array(await blob.arrayBuffer())
    let text = ''
    for (let i = 0; i < bytes.length; i += 16384) text += String.fromCharCode(...bytes.subarray(i, i + 16384))
    return btoa(text)
}

import {
    DESKTOP_SEMANTIC_BATCH_MAX,
    DESKTOP_SEMANTIC_DEADLINE_MS,
    DESKTOP_SEMANTIC_NOTE_MAX,
    desktopSemanticBackendIdentitySchema,
    type DesktopSemanticBackendIdentity,
    type DesktopSemanticEmbeddingPort,
} from '@rerun/contracts'
import { desktopSemanticVector } from './vectors.js'

// Root supplies this. The adapter never chooses a host, reads a ChatGPT login, or downloads a model.
export type DesktopSemanticEmbeddingCapability = {
    identity: DesktopSemanticBackendIdentity
    embed(texts: readonly string[], signal: AbortSignal): Promise<number[][] | 'refused'>
}

export function createDesktopSemanticEmbedder(capability: DesktopSemanticEmbeddingCapability | null): DesktopSemanticEmbeddingPort {
    const parsed = capability ? desktopSemanticBackendIdentitySchema.safeParse(capability.identity) : null
    const configured = capability && parsed?.success ? capability : null
    const identity = parsed && parsed.success ? parsed.data : null
    return {
        identity: () => identity,
        async embed(texts, signal, deadlineMs) {
            if (!configured || !identity) return { ok: false, reason: 'unconfigured' }
            const deadline = Number.isFinite(deadlineMs) && deadlineMs > 0 ? Math.min(deadlineMs, DESKTOP_SEMANTIC_DEADLINE_MS) : DESKTOP_SEMANTIC_DEADLINE_MS
            if (signal.aborted) return { ok: false, reason: 'cancelled' }
            if (texts.length < 1 || texts.length > DESKTOP_SEMANTIC_BATCH_MAX) return { ok: false, reason: 'invalid' }
            if (texts.some(text => typeof text !== 'string' || text.length < 1 || text.length > DESKTOP_SEMANTIC_NOTE_MAX)) return { ok: false, reason: 'invalid' }
            const timer = new AbortController()
            const timeout = setTimeout(() => timer.abort(), deadline)
            try {
                const linked = AbortSignal.any([signal, timer.signal])
                // A capability that ignores cancellation still cannot publish after the deadline.
                const vectors = await new Promise<number[][] | 'refused' | 'caller' | 'deadline'>((resolve, reject) => {
                    const onAbort = () => resolve(signal.aborted ? 'caller' : 'deadline')
                    if (linked.aborted) onAbort()
                    else linked.addEventListener('abort', onAbort, { once: true })
                    configured.embed(texts, linked).then(resolve, reject)
                })
                if (vectors === 'caller' || signal.aborted) return { ok: false, reason: 'cancelled' }
                if (vectors === 'deadline' || timer.signal.aborted) return { ok: false, reason: 'timeout' }
                if (vectors === 'refused') return { ok: false, reason: 'refused' }
                if (!Array.isArray(vectors) || vectors.length !== texts.length) return { ok: false, reason: 'invalid' }
                const checked: number[][] = []
                for (const vector of vectors) {
                    const valid = desktopSemanticVector(vector, identity.dimensions)
                    if (!valid) return { ok: false, reason: 'invalid' }
                    checked.push(valid)
                }
                return { ok: true, vectors: checked, identity }
            } catch {
                if (signal.aborted) return { ok: false, reason: 'cancelled' }
                if (timer.signal.aborted) return { ok: false, reason: 'timeout' }
                return { ok: false, reason: 'unavailable' }
            } finally {
                clearTimeout(timeout)
            }
        },
    }
}

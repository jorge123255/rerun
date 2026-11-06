import 'server-only'
import { z } from 'zod'
import { boundedText } from '../mcp/remote'
import type { desktopAuxiliaryStore } from './store'
import type { DesktopWebSearchInput, DesktopWebSearchResponse } from '@rerun/contracts'

export const DESKTOP_EMBEDDING_IDENTITY = { backendId: 'openrouter', model: 'openai/text-embedding-3-small', version: '1', dimensions: 1536 } as const
const embeddingReply = z.object({ data: z.array(z.object({ index: z.number().int().nonnegative(), embedding: z.array(z.number().finite()).length(1536) })).min(1).max(16) })
const braveReply = z.object({ web: z.object({ results: z.array(z.object({ title: z.string().optional(), url: z.string(), description: z.string().optional() })).max(20) }).optional() })

/** Original Rerun providers and models. Keys are scoped to this purpose and never taken from ChatGPT login. */
export function desktopAuxiliaryBackends(store: ReturnType<typeof desktopAuxiliaryStore>, fetcher: typeof fetch = fetch) {
    async function configured(purpose: 'search' | 'embedding' | 'transcription', revision?: string) {
        const credential = await store.read(purpose)
        if (!credential.key || revision !== undefined && credential.revision !== revision) throw new Error('This tool service is not configured or has changed.')
        return credential as { revision: string; key: string }
    }
    async function assertCurrent(purpose: 'search' | 'embedding' | 'transcription', revision: string, signal: AbortSignal) {
        signal.throwIfAborted(); await configured(purpose, revision); signal.throwIfAborted()
    }
    async function json(response: Response, signal: AbortSignal, bytes: number) {
        if (!response.ok) { void response.body?.cancel().catch(() => {}); throw new Error('The service did not accept the request.') }
        return JSON.parse(await boundedText(response, signal, bytes)) as unknown
    }
    return {
        async embed(texts: readonly string[], signal: AbortSignal, revision?: string) {
            if (!texts.length || texts.length > 16 || texts.some(text => !text.length || text.length > 8192)) throw new Error('Embedding input exceeds its limit.')
            const current = await configured('embedding', revision)
            signal.throwIfAborted()
            const response = await fetcher('https://openrouter.ai/api/v1/embeddings', { method: 'POST', headers: { Authorization: `Bearer ${current.key}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: DESKTOP_EMBEDDING_IDENTITY.model, input: texts, encoding_format: 'float' }), signal, redirect: 'error' })
            const parsed = embeddingReply.parse(await json(response, signal, 1_500_000))
            const vectors = [...parsed.data].sort((a, b) => a.index - b.index)
            if (vectors.length !== texts.length || vectors.some((value, index) => value.index !== index)) throw new Error('The embedding response is incomplete.')
            await assertCurrent('embedding', current.revision, signal)
            return vectors.map(value => value.embedding)
        },
        async transcribe(audio: Uint8Array, format: string, signal: AbortSignal) {
            if (!audio.length || audio.length > 8 * 1024 * 1024 || !['webm', 'ogg', 'wav', 'mp3', 'mp4', 'm4a'].includes(format)) throw new Error('This recording is unavailable.')
            const current = await configured('transcription')
            signal.throwIfAborted()
            const response = await fetcher('https://openrouter.ai/api/v1/audio/transcriptions', { method: 'POST', headers: { Authorization: `Bearer ${current.key}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'openai/whisper-large-v3-turbo', input_audio: { data: Buffer.from(audio).toString('base64'), format }, provider: { order: ['groq'], allow_fallbacks: true } }), signal, redirect: 'error' })
            const parsed = z.object({ text: z.string().max(32_768) }).parse(await json(response, signal, 150_000))
            await assertCurrent('transcription', current.revision, signal)
            return parsed.text.trim()
        },
        async search(input: DesktopWebSearchInput, revision: string, signal: AbortSignal): Promise<DesktopWebSearchResponse> {
            const current = await configured('search', revision)
            const url = new URL('https://api.search.brave.com/res/v1/web/search')
            url.searchParams.set('q', input.query); url.searchParams.set('count', String(input.maxResults))
            signal.throwIfAborted()
            const response = await fetcher(url, { headers: { Accept: 'application/json', 'X-Subscription-Token': current.key }, signal, redirect: 'error' })
            const parsed = braveReply.parse(await json(response, signal, 2_000_000))
            await assertCurrent('search', current.revision, signal)
            return { provenance: { provider: 'brave' }, results: (parsed.web?.results ?? []).slice(0, input.maxResults).map(value => ({ title: (value.title?.trim() || value.url).slice(0, 512), url: value.url, snippet: (value.description ?? '').slice(0, 4000) })) }
        },
    }
}

import 'server-only'
import { z } from 'zod'
import { boundedText } from '../mcp/remote'
import type { desktopAuxiliaryStore } from './store'
import type { DesktopWebSearchInput, DesktopWebSearchResponse } from '@rerun/contracts'

export const DESKTOP_EMBEDDING_IDENTITY = { backendId: 'openrouter', model: 'openai/text-embedding-3-small', version: '1', dimensions: 1536 } as const
const embeddingReply = z.object({ data: z.array(z.object({ index: z.number().int().nonnegative(), embedding: z.array(z.number().finite()).length(1536) })).min(1).max(16) })
const braveReply = z.object({ web: z.object({ results: z.array(z.object({ title: z.string().optional(), url: z.string(), description: z.string().optional() })).max(20) }).optional() })
const keirolabsReply = z.object({ results: z.array(z.object({
    title: z.string().nullish(), url: z.string().nullish(), snippet: z.string().nullish(),
})).max(20).optional() })

/** Original Rerun providers and models. Keys are scoped to this purpose and never taken from ChatGPT login. */
export function desktopAuxiliaryBackends(store: ReturnType<typeof desktopAuxiliaryStore>, fetcher: typeof fetch = fetch) {
    async function configured(purpose: 'embedding' | 'transcription', revision?: string) {
        const credential = await store.read(purpose)
        if (!credential.key || revision !== undefined && credential.revision !== revision) throw new Error('This tool service is not configured or has changed.')
        return credential as { revision: string; key: string }
    }
    async function assertCurrent(purpose: 'embedding' | 'transcription', revision: string, signal: AbortSignal) {
        signal.throwIfAborted(); await configured(purpose, revision); signal.throwIfAborted()
    }
    async function json(response: Response, signal: AbortSignal, bytes: number) {
        if (!response.ok) { void response.body?.cancel().catch(() => {}); throw new Error('The service did not accept the request.') }
        return JSON.parse(await boundedText(response, signal, bytes)) as unknown
    }
    async function searchBrave(input: DesktopWebSearchInput, key: string, signal: AbortSignal) {
        const url = new URL('https://api.search.brave.com/res/v1/web/search')
        url.searchParams.set('q', input.query); url.searchParams.set('count', String(input.maxResults))
        const response = await fetcher(url, { headers: { Accept: 'application/json', 'X-Subscription-Token': key }, signal, redirect: 'error' })
        const parsed = braveReply.parse(await json(response, signal, 2_000_000))
        return (parsed.web?.results ?? []).map(({ title, url, description }) => ({ title, url, snippet: description }))
    }
    // No key: the owner turned this on in Settings. The query leaves the Mac for Keenable.
    async function searchKeenable(input: DesktopWebSearchInput, parent: AbortSignal) {
        const signal = AbortSignal.any([parent, AbortSignal.timeout(10_000)])
        const response = await fetcher('https://api.keenable.ai/v1/search/public', {
            method: 'POST',
            headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-Keenable-Title': 'Rerun' },
            body: JSON.stringify({ query: input.query, max_results: input.maxResults, snippet_max_length: 400 }), signal, redirect: 'error',
        })
        const parsed = keirolabsReply.parse(await json(response, signal, 2_000_000))
        return (parsed.results ?? []).flatMap(({ title, url, snippet }) => url ? [{ title, url, snippet: snippet?.replace(/\s+/g, ' ').trim() }] : [])
    }
    async function transcribeElevenLabs(audio: Uint8Array, format: string, key: string, signal: AbortSignal) {
        const form = new FormData()
        form.set('model_id', 'scribe_v1')
        form.set('file', new Blob([audio as Uint8Array<ArrayBuffer>]), `recording.${format}`)
        const response = await fetcher('https://api.elevenlabs.io/v1/speech-to-text', { method: 'POST', headers: { 'xi-api-key': key }, body: form, signal, redirect: 'error' })
        return z.object({ text: z.string().max(32_768) }).parse(await json(response, signal, 2_000_000)).text
    }
    async function searchKeirolabs(input: DesktopWebSearchInput, key: string, parent: AbortSignal) {
        const signal = AbortSignal.any([parent, AbortSignal.timeout(10_000)])
        const response = await fetcher('https://api.keirolabs.cloud/api/v2/search/lite', {
            method: 'POST',
            headers: { Accept: 'application/json', 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
            body: JSON.stringify({ query: input.query, maxResults: input.maxResults }), signal, redirect: 'error',
        })
        const parsed = keirolabsReply.parse(await json(response, signal, 2_000_000))
        return (parsed.results ?? []).flatMap(({ title, url, snippet }) => url ? [{ title, url, snippet }] : [])
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
            if (!audio.length || audio.length > 8 * 1024 * 1024 || !['webm', 'ogg', 'wav', 'mp3', 'mp4', 'm4a', 'flac'].includes(format)) throw new Error('This recording is unavailable.')
            const current = await store.readTranscription()
            if (!current.key) throw new Error('This tool service is not configured or has changed.')
            signal.throwIfAborted()
            let text: string
            if (current.purpose === 'elevenlabs-transcription') text = await transcribeElevenLabs(audio, format, current.key, signal)
            else {
                const response = await fetcher('https://openrouter.ai/api/v1/audio/transcriptions', { method: 'POST', headers: { Authorization: `Bearer ${current.key}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'openai/whisper-large-v3-turbo', input_audio: { data: Buffer.from(audio).toString('base64'), format }, provider: { order: ['groq'], allow_fallbacks: true } }), signal, redirect: 'error' })
                text = z.object({ text: z.string().max(32_768) }).parse(await json(response, signal, 150_000)).text
            }
            // The key that paid for this must still be the one saved.
            const after = await store.readTranscription()
            signal.throwIfAborted()
            if (after.purpose !== current.purpose || after.revision !== current.revision) throw new Error('This tool service is not configured or has changed.')
            return text.trim()
        },
        async search(input: DesktopWebSearchInput, generation: string, signal: AbortSignal): Promise<DesktopWebSearchResponse> {
            // Pre-effect revision bind: stale key/config never reaches the provider and is not a provider failure.
            const { generation: current, credential } = await store.readSearch()
            if (current !== generation) throw new Error('Search capability changed.')
            if (!credential) throw new Error('This tool service is not configured or has changed.')
            signal.throwIfAborted()
            const { provider, key } = credential
            const results = await (provider === 'brave' ? searchBrave(input, key, signal) : provider === 'keirolabs' ? searchKeirolabs(input, key, signal) : searchKeenable(input, signal))
            if ((await store.readSearch()).generation !== generation) {
                // The provider may have accepted the request before the settings changed.
                throw new Error('Search capability changed after the provider request.')
            }
            signal.throwIfAborted()
            return { provenance: { provider }, results: results.slice(0, input.maxResults).map(value => ({ title: (value.title?.trim() || value.url).slice(0, 512), url: value.url, snippet: (value.snippet ?? '').slice(0, 4000) })) }
        },
    }
}

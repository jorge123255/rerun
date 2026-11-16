import 'server-only'
import { z } from 'zod'
import { DESKTOP_SEMANTIC_DIMENSIONS_MAX } from '@rerun/contracts'
import { DESKTOP_LOCAL_EMBEDDING_DOWNLOADS, desktopLocalEmbeddingModel, type DesktopLocalEmbeddingDownload, type DesktopLocalEmbeddingStatus } from '../../auxiliary'
import { boundedText } from '../mcp/remote'

/**
 * Memory search by a model running on this Mac. Ollama's own address on this machine is the only
 * place asked: the text of a coworker's notes never leaves the Mac, and no key is involved.
 */
export const DESKTOP_OLLAMA_ORIGIN = 'http://127.0.0.1:11434'
const tags = z.object({ models: z.array(z.object({ name: z.string().max(160), capabilities: z.array(z.string()).optional() })).max(500) })
const reply = z.object({ embeddings: z.array(z.array(z.number().finite()).min(1).max(DESKTOP_SEMANTIC_DIMENSIONS_MAX)).min(1).max(16) })
// How many numbers a model answers with, learned once per saved setting.
const sizes = new Map<string, number>()

export async function desktopLocalEmbeddingStatus(signal: AbortSignal, fetcher: typeof fetch = fetch): Promise<DesktopLocalEmbeddingStatus> {
    try {
        const stop = AbortSignal.any([signal, AbortSignal.timeout(2_000)])
        const response = await fetcher(`${DESKTOP_OLLAMA_ORIGIN}/api/tags`, { signal: stop, redirect: 'error' })
        if (!response.ok) { void response.body?.cancel().catch(() => {}); return { running: false, models: [], embeddingModels: [] } }
        const models = tags.parse(JSON.parse(await boundedText(response, stop, 500_000))).models
        const named = (list: typeof models) => list.map(model => model.name).filter(name => desktopLocalEmbeddingModel.safeParse(name).success).slice(0, 200)
        return { running: true, models: named(models), embeddingModels: named(models.filter(model => model.capabilities?.includes('embedding') || /embed/i.test(model.name))) }
    } catch {
        return { running: false, models: [], embeddingModels: [] }
    }
}

export async function embedDesktopLocally(model: string, texts: readonly string[], signal: AbortSignal, fetcher: typeof fetch = fetch): Promise<number[][]> {
    if (!desktopLocalEmbeddingModel.safeParse(model).success) throw new Error('This tool service is not configured or has changed.')
    if (!texts.length || texts.length > 16 || texts.some(text => !text.length || text.length > 8192)) throw new Error('Embedding input exceeds its limit.')
    const response = await fetcher(`${DESKTOP_OLLAMA_ORIGIN}/api/embed`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model, input: texts }), signal, redirect: 'error' })
    if (!response.ok) { void response.body?.cancel().catch(() => {}); throw new Error('The local model did not accept the request.') }
    const vectors = reply.parse(JSON.parse(await boundedText(response, signal, 3_000_000))).embeddings
    if (vectors.length !== texts.length || vectors.some(vector => vector.length !== vectors[0]!.length)) throw new Error('The embedding response is incomplete.')
    return vectors
}

/** What the engine files its index under. A different model, or a different size, is a different index. */
export async function desktopLocalEmbeddingIdentity(model: string, revision: string, signal: AbortSignal, fetcher: typeof fetch = fetch) {
    const key = `${revision}\0${model}`
    let dimensions = sizes.get(key)
    if (!dimensions) {
        dimensions = (await embedDesktopLocally(model, ['size check'], signal, fetcher))[0]!.length
        sizes.set(key, dimensions)
    }
    return { backendId: 'ollama', model: model.slice(0, 128), version: '1', dimensions } as const
}

// One download at a time, for this app launch. Ollama does the downloading and keeps the file; the
// app only asks it to, and repeats what Ollama says about how far along it is.
const KEY = Symbol.for('rerun.desktop.local-embedding.download.v1')
const slot = globalThis as typeof globalThis & { [KEY]?: { download: DesktopLocalEmbeddingDownload | null } }
const held = slot[KEY] ??= { download: null }
const progress = z.object({ status: z.string().max(400).optional(), total: z.number().nonnegative().optional(), completed: z.number().nonnegative().optional(), error: z.string().max(400).optional() })

export function desktopLocalEmbeddingDownload(): DesktopLocalEmbeddingDownload | null { return held.download }
export function resetDesktopLocalEmbeddingDownload() { held.download = null }

/** Asks Ollama to download one of the offered embedding models. Returns at once; progress is read with the status. */
export function startDesktopLocalEmbeddingDownload(model: string, fetcher: typeof fetch = fetch): { started: boolean; finished: Promise<void> } {
    if (!(DESKTOP_LOCAL_EMBEDDING_DOWNLOADS as readonly string[]).includes(model)) throw new Error('This model cannot be downloaded through Rerun.')
    if (held.download?.state === 'downloading') return { started: false, finished: Promise.resolve() }
    const current: DesktopLocalEmbeddingDownload = { model: model as DesktopLocalEmbeddingDownload['model'], state: 'downloading', percent: 0, message: 'Starting the download' }
    held.download = current
    const fail = (message: string) => { if (held.download === current) held.download = { ...current, state: 'failed', message: message.slice(0, 200) } }
    const finished = (async () => {
        const signal = AbortSignal.timeout(30 * 60_000)
        const response = await fetcher(`${DESKTOP_OLLAMA_ORIGIN}/api/pull`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model, stream: true }), signal, redirect: 'error' })
        if (!response.ok || !response.body) { void response.body?.cancel().catch(() => {}); return fail('Ollama did not start the download.') }
        const reader = response.body.getReader(), decoder = new TextDecoder()
        let pending = '', succeeded = false
        for (;;) {
            const chunk = await reader.read()
            if (chunk.done) break
            pending += decoder.decode(chunk.value, { stream: true })
            if (pending.length > 200_000) { void reader.cancel().catch(() => {}); return fail('Ollama sent an answer Rerun could not read.') }
            const lines = pending.split('\n'); pending = lines.pop() ?? ''
            for (const line of lines) {
                if (!line.trim()) continue
                const step = progress.safeParse(JSON.parse(line))
                if (!step.success) continue
                if (step.data.error) { void reader.cancel().catch(() => {}); return fail(step.data.error) }
                if (step.data.status === 'success') succeeded = true
                const percent = step.data.total ? Math.min(100, Math.floor((step.data.completed ?? 0) / step.data.total * 100)) : current.percent
                // The download comes in several files; the bar never runs backwards between them.
                current.percent = Math.max(current.percent, percent)
                current.message = (step.data.status ?? current.message).slice(0, 200)
            }
        }
        if (held.download !== current) return
        held.download = succeeded ? { ...current, state: 'done', percent: 100, message: 'Downloaded' } : { ...current, state: 'failed', message: 'The download stopped before it finished.' }
    })().catch(() => fail('Ollama could not be reached. Open Ollama and try again.'))
    return { started: true, finished }
}

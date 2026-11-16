import 'server-only'
import { z } from 'zod'
import { DESKTOP_SEMANTIC_DIMENSIONS_MAX } from '@rerun/contracts'
import { desktopLocalEmbeddingModel, type DesktopLocalEmbeddingStatus } from '../../auxiliary'
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

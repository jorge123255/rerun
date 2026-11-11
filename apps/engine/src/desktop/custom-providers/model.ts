import type { LoadedConnection } from '../../connections/types.js'
import { desktopCustomProviderBinding } from './binding.js'
import type { createCustomProviderRuntime } from './runtime.js'

type Model = Awaited<ReturnType<ReturnType<typeof createCustomProviderRuntime>['model']>>['model']
type Call = Parameters<Model['doGenerate']>[0]

/** Lease the exact registered revision for every SDK request, including compaction and one-shots. */
export function customInferenceModel(connection: LoadedConnection | null, modelId: string, effort?: string) {
    const binding = desktopCustomProviderBinding()
    const snapshot = connection?.custom
    if (!binding || !snapshot || snapshot.state !== 'configured' || snapshot.workspaceId !== binding.workspaceId
        || snapshot.connectionId !== connection?.id || !snapshot.config.models.some(model => model.id === modelId)) {
        throw new Error('Choose a model offered by the current custom connection.')
    }
    const stop = new AbortController()
    async function lease(params: Call) {
        const signal = params.abortSignal ? AbortSignal.any([stop.signal, params.abortSignal]) : stop.signal
        const bound = await binding!.model(snapshot!, modelId, signal, effort)
        const image = params.prompt.some(message => message.role === 'user'
            && message.content.some(part => part.type === 'file' && part.mediaType.startsWith('image/')))
        if (image && !bound.vision) {
            bound.close()
            throw new Error('This custom model is not configured for images.')
        }
        return bound
    }
    const model: Model = {
        specificationVersion: 'v3',
        provider: 'custom',
        modelId,
        supportedUrls: { 'image/*': [/^https?:\/\//] },
        async doGenerate(params) {
            const bound = await lease(params)
            try { return await bound.model.doGenerate({ ...params, abortSignal: bound.signal }) }
            finally { bound.close() }
        },
        async doStream(params) {
            const bound = await lease(params)
            try {
                const result = await bound.model.doStream({ ...params, abortSignal: bound.signal })
                const reader = result.stream.getReader()
                return { ...result, stream: new ReadableStream({
                    async pull(controller) {
                        try {
                            const next = await reader.read()
                            if (next.done) { bound.close(); controller.close() }
                            else controller.enqueue(next.value)
                        } catch (error) { bound.close(); controller.error(error) }
                    },
                    async cancel(reason) { try { await reader.cancel(reason) } finally { bound.close() } },
                }) }
            } catch (error) { bound.close(); throw error }
        },
    }
    return { model, close: async () => stop.abort() }
}

import { getConnection } from '../../connections/registry.js'
import type { DesktopTriggerEngineBinding } from '../triggers/binding.js'
import { bindDesktopTriggerTools } from './binding.js'

/** Reuses the live trigger runtime and its system-DB receipts; opens no listener or new store. */
export function createDesktopTriggerToolRuntime(source: DesktopTriggerEngineBinding) {
    const closing = new AbortController(), pending = new Set<Promise<unknown>>()
    const binding = bindDesktopTriggerTools({ lifecycle: source.lifecycle, store: source.store, authority: {
        assertActive() { closing.signal.throwIfAborted(); source.authority.assertActive() },
        resolveOwner: id => source.authority.resolveOwnerByEngineId(id),
        assertTriggerGrant: id => source.authority.assertTriggerGrant(id),
        assertSetupClear: id => source.authority.assertSetupClear(id),
        readRun: (id, runId) => source.authority.readRun(id, runId),
        connectedModel: async id => {
            const selected = await source.authority.resolveAutomationModel(id, { connectionId: null, provider: null, model: null })
            if (!selected.connectionId || !selected.model) return null
            const connection = await getConnection(selected.connectionId)
            closing.signal.throwIfAborted(); source.authority.assertActive()
            return { provider: connection.config.provider, model: selected.model }
        },
    } })
    const original = binding.tools
    binding.tools = (id, context) => {
        const tools = original(id, { ...context, abortSignal: AbortSignal.any([closing.signal, ...(context?.abortSignal ? [context.abortSignal] : [])]) })
        for (const tool of Object.values(tools)) {
            const execute = tool.execute
            if (!execute) continue
            tool.execute = ((...args: Parameters<typeof execute>) => {
                const running = Promise.resolve(execute(...args)); pending.add(running)
                return running.finally(() => pending.delete(running))
            }) as typeof execute
        }
        return tools
    }
    return { ...binding, async close() { closing.abort(); await Promise.allSettled([...pending]) } }
}

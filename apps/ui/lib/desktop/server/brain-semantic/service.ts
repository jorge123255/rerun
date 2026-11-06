import 'server-only'
import { desktopBrainSemanticIndexStatusSchema, desktopBrainSemanticSearchResultSchema, type DesktopBrainSemanticAuthority } from '@rerun/contracts'
import { request } from '@/lib/engine/client'
import type { DesktopRuntime } from '../runtime'
import { engineOf } from '../settings'

/** The engine owns canonical pages and its derived Brain DB. This adapter never opens either. */
export function createDesktopBrainSemanticServer(runtime: DesktopRuntime, authority: DesktopBrainSemanticAuthority) {
    const call = async <T>(owner: string, operation: 'status' | 'search' | 'index', body: unknown, parse: (value: unknown) => T, signal: AbortSignal) => {
        signal.throwIfAborted(); await authority(signal)
        if (!/^[A-Za-z0-9_-]{1,128}$/.test(owner)) throw new Error('Invalid coworker identity')
        const result = await request(engineOf(runtime), `/desktop/brain/semantic/${encodeURIComponent(owner)}/${operation}`, { method: operation === 'status' ? 'GET' : 'POST', ...(operation !== 'status' && { body: JSON.stringify(body) }), signal, cache: 'no-store' }, parse)
        await authority(signal); signal.throwIfAborted(); return result
    }
    return {
        status: (owner: string, signal: AbortSignal) => call(owner, 'status', null, v => desktopBrainSemanticIndexStatusSchema.parse(v), signal),
        reconcile: (owner: string, embed: boolean, signal: AbortSignal) => call(owner, 'index', { embed }, v => desktopBrainSemanticIndexStatusSchema.parse(v), signal),
        search: (owner: string, query: string, limit: number, signal: AbortSignal) => call(owner, 'search', { query, limit }, v => desktopBrainSemanticSearchResultSchema.parse(v), signal),
    }
}

import type { DesktopTriggerStore } from './types.js'

/**
 * Shape expected by UI `DesktopTriggerDurableStore` / configureDesktopTriggersManagement.
 * Root bridges engine store across processes (same pattern as schedule authorize/adopt callbacks).
 * This adapter is for in-process wiring and as the typed contract for that bridge — it is NOT a
 * memory fallback and must only wrap a real DesktopTriggerStore backed by system DB.
 */
export type DesktopTriggerDurableManagement = {
    getRevision(engineAgentId: string, slug: string): Promise<string>
    bumpRevision(engineAgentId: string, slug: string): Promise<string>
    findMutation(engineAgentId: string, requestId: string): Promise<{ kind: string; resultJson: string } | null>
    rememberMutation(input: { engineAgentId: string; requestId: string; kind: string; slug: string; resultJson: string }): Promise<void>
    listEvents(engineAgentId: string, slug?: string): Promise<unknown[]>
}

export function asDesktopTriggerDurableManagement(store: DesktopTriggerStore): DesktopTriggerDurableManagement {
    return {
        async getRevision(engineAgentId, slug) {
            return (await store.getRevision(engineAgentId, slug)) ?? (await store.bumpRevision(engineAgentId, slug))
        },
        bumpRevision: (engineAgentId, slug) => store.bumpRevision(engineAgentId, slug),
        async findMutation(engineAgentId, requestId) {
            const found = await store.findMutation(engineAgentId, requestId)
            return found ? { kind: found.kind, resultJson: found.resultJson } : null
        },
        rememberMutation: input => store.rememberMutation({
            engineAgentId: input.engineAgentId,
            requestId: input.requestId,
            kind: input.kind as 'create' | 'update' | 'rotate' | 'delete' | 'enable' | 'disable',
            slug: input.slug,
            revisionBefore: null,
            revisionAfter: null,
            resultJson: input.resultJson,
        }),
        listEvents: (engineAgentId, slug) => store.listEvents(engineAgentId, slug),
    }
}

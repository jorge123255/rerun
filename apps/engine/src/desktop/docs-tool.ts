import { tool, type ToolSet } from 'ai'
import { desktopForemanDocsQuerySchema, FOREMAN_SEARCH_DOCS_DESCRIPTION } from '@rerun/contracts'
import { beginDesktopAgentWork } from './agent-lifecycle.js'
import { desktopInternalJson } from './internal-client.js'
import { hasDesktopToolGrant, requireDesktopToolGrant } from './tool-grants.js'

const grant = 'docs'
type Identity = { agentId: string; sessionId: string; runId: string; toolCallId: string }
export type DesktopDocsSearch = (identity: Identity, query: string, signal: AbortSignal) => Promise<unknown>

/** The app reads the public documentation; the engine only asks, after the app has checked this run's permission. */
export const desktopDocsSearch: DesktopDocsSearch = (identity, query, stop) => {
    const signal = AbortSignal.any([stop, AbortSignal.timeout(25_000)])
    return desktopInternalJson('/api/desktop/internal/docs-search', { identity, query }, signal, 200_000)
}

/** A coworker answers questions about Rerun from the documentation (upstream #208), behind its own permission. */
export function desktopDocsTools(ctx: Parameters<typeof requireDesktopToolGrant>[0], search: DesktopDocsSearch = desktopDocsSearch): ToolSet {
    if (!hasDesktopToolGrant(ctx.agent.config, grant)) return {}
    return {
        search_docs: tool({
            description: FOREMAN_SEARCH_DOCS_DESCRIPTION,
            inputSchema: desktopForemanDocsQuerySchema,
            execute: async ({ query }, options) => {
                const signals = [ctx.abortSignal, options.abortSignal].filter((value): value is AbortSignal => !!value)
                const signal = signals.length ? AbortSignal.any(signals) : undefined
                if (!signal || !ctx.runId) throw new Error('Documentation search requires an active, cancellable run.')
                signal.throwIfAborted()
                await requireDesktopToolGrant({ ...ctx, abortSignal: signal }, grant)
                const release = beginDesktopAgentWork(ctx.agent.id)
                try {
                    return await search({ agentId: ctx.agent.id, sessionId: ctx.sessionId, runId: ctx.runId, toolCallId: options.toolCallId }, query, signal)
                } finally { release() }
            },
        }),
    }
}

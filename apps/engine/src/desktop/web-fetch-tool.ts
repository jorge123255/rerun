import { tool, type ToolSet } from 'ai'
import { withAgentLock } from '../agents/lock.js'
import type { RunContext } from '../runtime/context.js'
import { beginDesktopAgentWork } from './agent-lifecycle.js'
import { hasDesktopToolGrant, requireDesktopToolGrant } from './tool-grants.js'
import { isolatedScreenOwner } from './isolated-screen/binding.js'
import { desktopWebFetchContinuationPublisher, webFetchRunGeneration } from './web-fetch-continuation/index.js'
import { executeWebFetch, webFetchDescription, webFetchInputSchema } from './web-fetch/index.js'

export function desktopWebFetchTools(ctx: RunContext): ToolSet {
    if (!hasDesktopToolGrant(ctx.agent.config, 'webFetch')) return {}
    return {
        web_fetch: tool({
            description: webFetchDescription,
            inputSchema: webFetchInputSchema,
            execute: async (input, options) => {
                // Codex's bridged execute may omit options.abortSignal; the run's signal is
                // authoritative. Refuse an uninterruptible call instead of inventing a signal.
                const signal = ctx.abortSignal ?? options.abortSignal
                if (!signal) throw new Error('Web fetching requires an active, cancellable run.')
                signal.throwIfAborted()
                const release = beginDesktopAgentWork(ctx.agent.id)
                try {
                    const continuation = (() => {
                        if (!ctx.runId || !options.toolCallId) return undefined
                        try {
                            return {
                                identity: {
                                    engineAgentId: ctx.agent.id,
                                    sessionId: ctx.sessionId,
                                    runId: ctx.runId,
                                    toolCallId: options.toolCallId,
                                    target: {
                                        engineAgentId: ctx.agent.id,
                                        launchNonce: isolatedScreenOwner(ctx.agent.id).launchNonce,
                                        sessionGeneration: webFetchRunGeneration(ctx.runId),
                                    },
                                    url: webFetchInputSchema.parse(input).url,
                                },
                                publish: desktopWebFetchContinuationPublisher,
                            }
                        } catch {
                            return undefined
                        }
                    })()
                    const result = await executeWebFetch(input, {
                        coworkerId: ctx.agent.id,
                        signal,
                        ...(continuation ? { continuation } : {}),
                        assertPermission: async id => {
                            if (id !== ctx.agent.id) throw new Error('This web request belongs to another coworker.')
                            // Read current persisted permission under the same short lock used
                            // by revoke/disable/delete. Never hold the lock during network I/O.
                            await withAgentLock(id, async () => {
                                signal.throwIfAborted()
                                const finishRead = beginDesktopAgentWork(id)
                                try { await requireDesktopToolGrant({ ...ctx, abortSignal: signal }, 'webFetch') }
                                finally { finishRead() }
                            })
                        },
                    })
                    signal.throwIfAborted()
                    // Throw like other denied/failed desktop tools so provider adapters record
                    // failure. A UI { type: 'error-text' } object is not an execution envelope.
                    if (result.failed) throw new Error(result.text)
                    // Untrusted content remains the same call's tool output, never a prompt.
                    return result.text
                } finally { release() }
            },
        }),
    }
}

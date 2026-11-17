import { tool, type ToolSet } from 'ai'
import type { z } from 'zod'
import { DESKTOP_REPOSITORY_TOOL_DESCRIPTIONS, DESKTOP_REPOSITORY_TOOL_NAMES, DESKTOP_REPOSITORY_WORKSPACE_GRANT, desktopRepositoryToolInputs, type DesktopRepositoryToolName } from '@rerun/contracts'
import { beginDesktopAgentWork } from './agent-lifecycle.js'
import { desktopInternalJson } from './internal-client.js'
import { hasDesktopToolGrant, requireDesktopToolGrant } from './tool-grants.js'

type Identity = { agentId: string; sessionId: string; runId: string; toolCallId: string }
export type DesktopRepositoryCall = (identity: Identity, name: DesktopRepositoryToolName, input: unknown, signal: AbortSignal) => Promise<unknown>

/**
 * The app keeps the coworker's working copy of its repository and does everything that touches
 * git or GitHub; the engine only asks, after the app has checked this run's permission. No path
 * on the Mac, no sign-in and no program from the repository ever reaches this process.
 */
export const desktopRepositoryCall: DesktopRepositoryCall = (identity, name, input, stop) => {
    // Fetching a large repository for the first time is answered as "still being fetched" well inside this.
    const signal = AbortSignal.any([stop, AbortSignal.timeout(name === 'repo_publish' ? 330_000 : 90_000)])
    return desktopInternalJson('/api/desktop/internal/repository', { identity, tool: name, input }, signal, 400_000)
}

/** A coworker's tools for the one GitHub repository the person set for it, behind their own permission. */
export function desktopRepositoryTools(ctx: Parameters<typeof requireDesktopToolGrant>[0], call: DesktopRepositoryCall = desktopRepositoryCall): ToolSet {
    if (!hasDesktopToolGrant(ctx.agent.config, DESKTOP_REPOSITORY_WORKSPACE_GRANT)) return {}
    const tools: ToolSet = {}
    for (const name of DESKTOP_REPOSITORY_TOOL_NAMES) {
        tools[name] = tool({
            description: DESKTOP_REPOSITORY_TOOL_DESCRIPTIONS[name],
            // One loop makes all twelve: each tool keeps its own schema, which the union of them cannot say.
            inputSchema: desktopRepositoryToolInputs[name] as z.ZodType<Record<string, unknown>>,
            execute: async (input: Record<string, unknown>, options) => {
                const signals = [ctx.abortSignal, options.abortSignal].filter((value): value is AbortSignal => !!value)
                const signal = signals.length ? AbortSignal.any(signals) : undefined
                if (!signal || !ctx.runId) throw new Error('Working on the repository requires an active, cancellable run.')
                signal.throwIfAborted()
                await requireDesktopToolGrant({ ...ctx, abortSignal: signal }, DESKTOP_REPOSITORY_WORKSPACE_GRANT)
                const release = beginDesktopAgentWork(ctx.agent.id)
                try {
                    return await call({ agentId: ctx.agent.id, sessionId: ctx.sessionId, runId: ctx.runId, toolCallId: options.toolCallId }, name, input, signal)
                } finally { release() }
            },
        })
    }
    return tools
}

import { tool, type ToolSet } from 'ai'
import type { LoadedAgent } from '../../agents/types.js'
import type { RunContext } from '../../runtime/context.js'
import { workspaceDir } from '../../config/paths.js'
import { sessionClaim } from '../../runtime/run-control.js'
import { executeWebFetch, webFetchDescription, webFetchInputSchema } from '../web-fetch/index.js'

type Scope = { agent: LoadedAgent; sessionId: string; runId: string | null; signal: AbortSignal; tools: readonly string[]; authorize: (tool: string) => Promise<void> }
const scopes = new Map<string, Scope>()
export function registerDelegationChild(scope: Scope) {
    if (scopes.has(scope.agent.id)) throw new Error('Delegation child already exists')
    if (!scope.agent.config.ephemeral || scope.tools.some(name => name !== 'web_fetch')) throw new Error('Invalid delegated child scope')
    scopes.set(scope.agent.id, scope)
    return { runCreated: (runId: string) => { if (scope.runId) throw new Error('Delegation child cannot launch twice'); scope.runId = runId }, close: () => { if (scopes.get(scope.agent.id) === scope) scopes.delete(scope.agent.id) } }
}
function match(agent: LoadedAgent): Scope | undefined {
    const scope = scopes.get(agent.id)
    if (!scope) return undefined
    scope.signal.throwIfAborted()
    // runAgent may clone its loaded view. Only the private allocation and unchanged exact
    // isolated config are accepted, never an arbitrary ephemeral/name flag from disk.
    if (JSON.stringify(agent.config) !== JSON.stringify(scope.agent.config) || agent.soul !== scope.agent.soul || agent.install !== '' || Object.keys(agent.env).length || agent.resolved.connection?.id !== scope.agent.resolved.connection?.id || agent.resolved.model !== scope.agent.resolved.model || agent.resolved.provider !== scope.agent.resolved.provider) throw new Error('Delegation child scope changed')
    return scope
}
export function desktopDelegationCodexCwd(agent: LoadedAgent): string | undefined {
    const scope = match(agent)
    if (!scope) { if (agent.config.ephemeral) throw new Error('Unowned ephemeral provider'); return undefined }
    return workspaceDir(agent.id)
}
/** Root invokes before ordinary desktop tool construction. */
export async function desktopDelegationChildTools(ctx: RunContext): Promise<{ tools: ToolSet; close: () => Promise<void> } | null> {
    const scope = match(ctx.agent)
    if (!scope) { if (ctx.agent.config.ephemeral) throw new Error('Unowned ephemeral tool scope'); return null }
    const check = async (name: string) => {
        if (match(ctx.agent) !== scope) throw new Error('Delegation child scope changed')
        scope.signal.throwIfAborted(); ctx.abortSignal?.throwIfAborted()
        if (!scope.runId || scope.runId !== ctx.runId || scope.sessionId !== ctx.sessionId || sessionClaim(ctx.sessionId)?.runId !== scope.runId || !scope.tools.includes(name)) throw new Error('Delegation run changed')
        await scope.authorize(name)
        if (match(ctx.agent) !== scope || scope.runId !== ctx.runId || scope.sessionId !== ctx.sessionId || sessionClaim(ctx.sessionId)?.runId !== scope.runId) throw new Error('Delegation run changed')
        scope.signal.throwIfAborted(); ctx.abortSignal?.throwIfAborted()
    }
    const tools: ToolSet = {}
    if (scope.tools.includes('web_fetch')) tools.web_fetch = tool({ description: webFetchDescription, inputSchema: webFetchInputSchema,
        execute: async (input, options) => {
            await check('web_fetch')
            const signal = AbortSignal.any([scope.signal, ...(ctx.abortSignal ? [ctx.abortSignal] : []), ...(options.abortSignal ? [options.abortSignal] : [])])
            const result = await executeWebFetch(input, { coworkerId: ctx.agent.id, signal, assertPermission: async () => check('web_fetch') })
            await check('web_fetch'); return result
        },
    })
    return { tools, close: async () => {} }
}

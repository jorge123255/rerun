import type { RunContext } from '../../runtime/context.js'
import { hasDesktopToolGrant, requireDesktopToolGrant } from '../tool-grants.js'
import { resolveDesktopMcpSignInServer } from './bridge.js'
import type { ToolSet } from 'ai'
import { z } from 'zod'
import { desktopMcpSignInRequestInputSchema, desktopMcpSignInServerSchema, type DesktopMcpSignInRequestInput, type DesktopMcpSignInServer } from '@rerun/contracts'
import { HITL_ACK, hitlAck } from '../../tools/builtin/hitl.js'

export type DesktopMcpSignInToolAuthority = {
    authorize: (context: { toolCallId: string; abortSignal?: AbortSignal }) => Promise<void>
    deliver: (input: DesktopMcpSignInRequestInput, context: { toolCallId: string; abortSignal?: AbortSignal }) => Promise<DesktopMcpSignInServer>
}

// `ack` follows the turn order of the run, so a model that calls first is told to write its message now.
export function createDesktopMcpSignInTool(authority: DesktopMcpSignInToolAuthority, ack: ReturnType<typeof hitlAck> = HITL_ACK): ToolSet {
    return {
        request_mcp_sign_in: {
            description: 'Ask the user to sign in to an already registered MCP server that supports OAuth, then END YOUR TURN. The server name must come from the current trusted registration; never invent a URL or credential destination. The user connects through the desktop OAuth adapter. Connection state and any tool permission are checked separately. The result contains only the server name.',
            inputSchema: z.object({ name: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/), reason: z.string().max(300).nullish() }).strict(),
            execute: async (input, options) => {
                const context = { toolCallId: options.toolCallId, abortSignal: options.abortSignal }
                context.abortSignal?.throwIfAborted()
                await authority.authorize(context)
                context.abortSignal?.throwIfAborted()
                const parsed = desktopMcpSignInRequestInputSchema.parse({ name: input.name, ...(input.reason != null ? { reason: input.reason } : {}) })
                const server = desktopMcpSignInServerSchema.parse(await authority.deliver(parsed, context))
                if (server.name !== parsed.name) throw new Error('MCP sign-in delivery returned a different server.')
                context.abortSignal?.throwIfAborted()
                return { ...ack, server }
            },
        },
    }
}

export function desktopMcpSignInTools(ctx: RunContext): ToolSet {
    if (!ctx.runId || !hasDesktopToolGrant(ctx.agent.config, 'mcp') || ctx.agent.config.ephemeral) return {}
    return createDesktopMcpSignInTool({
        authorize: async ({ toolCallId, abortSignal }) => {
            if (!toolCallId || toolCallId.length > 256) throw new Error('MCP sign-in source is unavailable.')
            abortSignal?.throwIfAborted(); await requireDesktopToolGrant(ctx, 'mcp'); abortSignal?.throwIfAborted()
        },
        deliver: (input, context) => resolveDesktopMcpSignInServer({ engineAgentId: ctx.agent.id, sessionId: ctx.sessionId, runId: ctx.runId! }, input, context.abortSignal),
    }, hitlAck(ctx.turnOrder))
}

import type { ToolSet } from 'ai'
import { z } from 'zod'
import { desktopMcpSignInRequestInputSchema, desktopMcpSignInSourceSchema, type DesktopMcpSignInRequestInput, type DesktopMcpSignInSource } from '@rerun/contracts'
import { HITL_ACK } from '../../tools/builtin/hitl.js'

export type DesktopMcpSignInToolAuthority = {
    authorize: (context: { toolCallId: string; abortSignal?: AbortSignal }) => Promise<void>
    deliver: (input: DesktopMcpSignInRequestInput, context: { toolCallId: string; abortSignal?: AbortSignal }) => Promise<DesktopMcpSignInSource>
}

export function createDesktopMcpSignInTool(authority: DesktopMcpSignInToolAuthority): ToolSet {
    return {
        request_mcp_sign_in: {
            description: 'Ask the user to sign in to an already registered MCP server that supports OAuth, then END YOUR TURN. The server name must come from the current trusted registration; never invent a URL or credential destination. The user connects through the desktop OAuth adapter. Connection state and any tool permission are checked separately. The result contains only the server name.',
            inputSchema: z.object({ name: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/), reason: z.string().max(300).optional() }).strict(),
            execute: async (input, options) => {
                const context = { toolCallId: options.toolCallId, abortSignal: options.abortSignal }
                context.abortSignal?.throwIfAborted()
                await authority.authorize(context)
                context.abortSignal?.throwIfAborted()
                const parsed = desktopMcpSignInRequestInputSchema.parse(input)
                const source = desktopMcpSignInSourceSchema.parse(await authority.deliver(parsed, context))
                if (source.toolCallId !== context.toolCallId) throw new Error('MCP sign-in delivery returned a different source tool call.')
                return HITL_ACK
            },
        },
    }
}

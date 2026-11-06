import type { ToolSet } from 'ai'
import { z } from 'zod'
import { HITL_ACK, jsonTolerantArray } from '../../tools/builtin/hitl.js'
import { desktopSecretRequestInputSchema, desktopSecretRequestSourceSchema, type DesktopSecretRequestInput, type DesktopSecretRequestSource } from '@rerun/contracts'
import type { RunContext } from '../../runtime/context.js'
import { hasDesktopToolGrant, requireDesktopToolGrant } from '../tool-grants.js'

export type DesktopSecretRequestToolAuthority = {
    authorize: (context: { toolCallId: string; abortSignal?: AbortSignal }) => Promise<void>
    deliver?: (input: DesktopSecretRequestInput, context: { toolCallId: string; abortSignal?: AbortSignal }) => Promise<DesktopSecretRequestSource>
}

export function createDesktopSecretRequestTool(authority: DesktopSecretRequestToolAuthority): ToolSet {
    return {
        request_secret: {
            description: 'Ask the user for one to eight credentials through the secure masked desktop form, then END YOUR TURN. Group credentials needed for one setup into one call. Never ask for secrets in chat or files. Values are encrypted for this coworker and are never returned to you; the result contains only variable names. Storage alone grants no credential use: only separately authorized supported operations may use them. Use suggest_service instead when the service is in the catalog.',
            inputSchema: z.object({
                secrets: jsonTolerantArray(z.array(z.object({
                    key: z.string().regex(/^[A-Z][A-Z0-9_]*$/).max(64).describe('SCREAMING_SNAKE_CASE credential name.'),
                    label: z.string().min(1).max(100).describe('Short human label, not a sentence.'),
                    help: z.string().max(300).nullish().describe('One short line telling the user where to find the value.'),
                    docsUrl: z.string().url().max(2048).nullish().describe('Optional HTTPS page where the user can create or copy this credential.'),
                })).min(1).max(8)),
                reason: z.string().max(300).nullish().describe('One short line explaining what these credentials are for.'),
            }),
            execute: async (input, options) => {
                const context = { toolCallId: options.toolCallId, abortSignal: options.abortSignal }
                context.abortSignal?.throwIfAborted()
                await authority.authorize(context)
                context.abortSignal?.throwIfAborted()
                const fields = input.secrets.map(({ help, docsUrl, ...field }: { key: string; label: string; help?: string | null; docsUrl?: string | null }) => ({ ...field,
                    ...(help != null ? { help } : {}), ...(docsUrl != null ? { docsUrl } : {}),
                }))
                const parsed = desktopSecretRequestInputSchema.parse({ fields, ...(input.reason != null ? { reason: input.reason } : {}) })
                if (authority.deliver) {
                    const source = desktopSecretRequestSourceSchema.parse(await authority.deliver(parsed, context))
                    if (source.toolCallId !== context.toolCallId) throw new Error('Credential delivery returned a different source tool call.')
                }
                context.abortSignal?.throwIfAborted()
                return HITL_ACK
            },
        },
    }
}

export function desktopSecretRequestTools(ctx: RunContext): ToolSet {
    if (!ctx.runId || !hasDesktopToolGrant(ctx.agent.config, 'requestSecret') || ctx.agent.config.ephemeral) return {}
    return createDesktopSecretRequestTool({ authorize: async ({ toolCallId, abortSignal }) => {
        if (!toolCallId || toolCallId.length > 256) throw new Error('Credential request source is unavailable.')
        abortSignal?.throwIfAborted()
        await requireDesktopToolGrant(ctx, 'requestSecret')
        abortSignal?.throwIfAborted()
    } })
}

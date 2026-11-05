import { parseDesktopServiceRequestInput } from '@rerun/contracts'
import type { ToolSet } from 'ai'
import { z } from 'zod'
import type { RunContext } from '../../runtime/context.js'
import { jsonTolerantArray, suggestServiceTool } from '../../tools/builtin/hitl.js'
import { readAgentConfig } from '../../agents/loader.js'
import { cardCallTiming } from '../../agents/turn-order.js'

const duplicateMessage = 'Suggest each catalog app once. Duplicate slugs were not delivered.'
const invalidMessage = 'Use one to twenty exact catalog slugs and a short reason so the apps can be shown in chat.'

function suggestGranted(config: { enabled: boolean; tools: { desktopToolGrants?: unknown } }): boolean {
    if (!config.enabled) return false
    const grants = config.tools.desktopToolGrants
    if (!grants || typeof grants !== 'object') return false
    // The Apps grant is separate. Suggesting an app does not enable it or store a credential.
    return (grants as Record<string, unknown>).suggestService === true
}

export function desktopSuggestServiceTools(ctx: RunContext, readConfig: (id: string) => Promise<{ enabled: boolean; tools: { desktopToolGrants?: unknown } } | null> = readAgentConfig): ToolSet {
    if (!suggestGranted(ctx.agent.config)) return {}
    const original = suggestServiceTool(ctx).suggest_service!
    return {
        suggest_service: {
            ...original,
            description: `Suggest one to twenty catalog apps needed for the user's next step, then END YOUR TURN. Explain what you prepared and what each app unlocks. Use exact catalog slugs, each once. The user can configure the apps through the existing Apps panel, select an existing connection, or skip, then explicitly finish the setup card. Opening or closing Apps is not an answer. Never request secrets in chat or files, enable permissions, or assume the app is connected. This tool does not enable the separate Apps permission. ${cardCallTiming(ctx.turnOrder)}`,
            inputSchema: z.object({ services: jsonTolerantArray(z.array(z.object({
                slug: z.string().min(1).max(200).describe('The exact catalog app slug, without a connection instance suffix.'),
                reason: z.string().max(300).nullish().describe('One short line explaining why this app helps with the user’s request.'),
            })).min(1).max(20)) }),
            execute: async (input, options) => {
                ctx.abortSignal?.throwIfAborted()
                const current = await readConfig(ctx.agent.id).catch(() => null)
                ctx.abortSignal?.throwIfAborted()
                if (!current || !suggestGranted(current)) throw new Error('This tool is turned off for this coworker.')
                const parsed = parseDesktopServiceRequestInput(input)
                if (!parsed.ok) throw new Error(parsed.reason === 'duplicate-slug' ? duplicateMessage : invalidMessage)
                return original.execute!(input, options)
            },
        },
    }
}

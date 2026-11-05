import { parseDesktopServiceRequestInput } from '@rerun/contracts'
import type { ToolSet } from 'ai'
import type { RunContext } from '../../runtime/context.js'
import { suggestServiceTool } from '../../tools/builtin/hitl.js'
import { readAgentConfig } from '../../agents/loader.js'

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

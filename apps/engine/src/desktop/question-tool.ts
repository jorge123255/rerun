import { desktopQuestionInput } from '@rerun/contracts'
import type { ToolSet } from 'ai'
import type { RunContext } from '../runtime/context.js'
import { askUserTool } from '../tools/builtin/hitl.js'
import { hasDesktopToolGrant, requireDesktopToolGrant } from './tool-grants.js'

export function desktopQuestionTools(ctx: RunContext): ToolSet {
    // The desktop grant is the explicit permission. The separate hosted askUser flag has no
    // desktop control, and must not silently defeat the user's selection in Tools.
    if (!hasDesktopToolGrant(ctx.agent.config, 'askUser')) return {}
    // Only mention card_file when this coworker may actually show one.
    const original = askUserTool({ ...ctx, agent: { ...ctx.agent, config: { ...ctx.agent.config, tools: { ...ctx.agent.config.tools, cards: hasDesktopToolGrant(ctx.agent.config, 'cardFile') } } } }).ask_user!
    return {
        ask_user: {
            ...original,
            execute: async (input, options) => {
                await requireDesktopToolGrant(ctx, 'askUser')
                if (!desktopQuestionInput(input)) throw new Error('Use shorter questions and fewer choices so the questions can be shown in chat.')
                return original.execute!(input, options)
            },
        },
    }
}

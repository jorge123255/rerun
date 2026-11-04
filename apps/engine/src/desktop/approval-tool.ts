import { desktopApprovalInput } from '@rerun/contracts'
import type { ToolSet } from 'ai'
import type { RunContext } from '../runtime/context.js'
import { requestApprovalTool } from '../tools/builtin/hitl.js'
import { hasDesktopToolGrant, requireDesktopToolGrant } from './tool-grants.js'

export function desktopApprovalTools(ctx: RunContext): ToolSet {
    if (!hasDesktopToolGrant(ctx.agent.config, 'requestApproval')) return {}
    const original = requestApprovalTool(ctx).request_approval!
    return {
        request_approval: {
            ...original,
            execute: async (input, options) => {
                await requireDesktopToolGrant(ctx, 'requestApproval')
                if (!desktopApprovalInput(input)) throw new Error('Use shorter action descriptions and fewer approvals so they can be shown in chat.')
                // This original acknowledgement ends the turn. It grants no tool permission and
                // executes no proposed action; the decisions arrive as the next user message.
                return original.execute!(input, options)
            },
        },
    }
}

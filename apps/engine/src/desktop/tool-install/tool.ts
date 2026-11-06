import { tool, type ToolSet } from 'ai'
import { desktopToolInstallInputSchema, type DesktopToolInstallPorts } from '@rerun/contracts'
import type { RunContext } from '../../runtime/context.js'
import { beginDesktopAgentWork } from '../agent-lifecycle.js'
import { hasDesktopToolGrant } from '../tool-grants.js'
import { createDesktopToolInstallService } from './service.js'

export { desktopToolInstallActivity, desktopToolInstallApprovalItems, desktopToolInstallOutcomeText } from './projections.js'

const grant = 'toolInstall' as Parameters<typeof hasDesktopToolGrant>[1]

export function desktopToolInstallTools(ctx: RunContext, ports: DesktopToolInstallPorts): ToolSet {
    if (!ctx.agent.config.selfImprovement.enabled || !ctx.agent.config.selfImprovement.allowToolInstall || !hasDesktopToolGrant(ctx.agent.config, grant)) return {}
    const service = createDesktopToolInstallService(ports)
    return {
        tool_install: tool({
            description: 'Review exact npm package@version targets for installation in this coworker’s isolated computer. Approval is required before any package executes. Packages remain available only in that guest.',
            inputSchema: desktopToolInstallInputSchema,
            execute: async (input, options) => {
                const signal = ctx.abortSignal || options.abortSignal ? AbortSignal.any([...(ctx.abortSignal ? [ctx.abortSignal] : []), ...(options.abortSignal ? [options.abortSignal] : [])]) : undefined
                if (!signal || !ctx.runId) throw new Error('Tool installation requires an active, cancellable run.')
                signal.throwIfAborted()
                const release = beginDesktopAgentWork(ctx.agent.id)
                try {
                    return await service.propose({
                        agentId: ctx.agent.id,
                        sessionId: ctx.sessionId,
                        runId: ctx.runId,
                        toolCallId: options.toolCallId,
                        proposalRevision: '1',
                    }, input, signal)
                } finally { release() }
            },
        }),
    }
}

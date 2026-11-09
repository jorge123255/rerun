import { tool, type ToolSet } from 'ai'
import { z } from 'zod'
import type { RunContext } from '../../runtime/context.js'
import { authorMetadata } from '../../runtime/notify.js'
import { beginDesktopAgentWork } from '../agent-lifecycle.js'
import { hasDesktopToolGrant, requireDesktopToolGrant } from '../tool-grants.js'
import { desktopNotifyUserEventKey, desktopNotifyUserModelReceipt, type DesktopNotifyUserAdmission, type DesktopNotifyUserReceipt } from './contract.js'
import { deliverDesktopUserNotification } from './delivery.js'

const MAX_MESSAGE_LENGTH = 16_000

export function desktopNotifyTools(ctx: RunContext, ports: { deliver: (input: DesktopNotifyUserAdmission, signal: AbortSignal) => Promise<DesktopNotifyUserReceipt> } = { deliver: deliverDesktopUserNotification }): ToolSet {
    if (!hasDesktopToolGrant(ctx.agent.config, 'notify')) return {}
    return {
        notify_user: tool({
            description:
                'Ask the user to look at a result, risk, or decision while you keep working. This does not pause you and does not wait for a reply. The inboxStatus field confirms whether the notice was recorded. When nativeStatus is accepted, report that macOS accepted the request. That does not confirm a visible alert or that the user saw it. Make at most one attempt for each notification. Use ask_user for an answer, request_approval for a go-ahead, suggest_service for a service, or request_secret for a credential.',
            inputSchema: z.object({
                message: z.string().max(MAX_MESSAGE_LENGTH).describe('The human-readable message to show the user.'),
                kind: z.enum(['info']).default('info').describe('Always info: this tool has exactly one purpose, asking the user to look at something.'),
                metadata: z.record(z.string(), z.any()).optional().describe('Optional structured context (e.g. a URL, a proposed action, options to choose from).'),
            }),
            execute: async ({ message, metadata }, options) => {
                if (!options.toolCallId) throw new Error('notify_user requires a tool call identity.')
                const signal = AbortSignal.any([...(ctx.abortSignal ? [ctx.abortSignal] : []), ...(options.abortSignal ? [options.abortSignal] : []), AbortSignal.timeout(20_000)])
                const release = beginDesktopAgentWork(ctx.agent.id)
                try {
                    await requireDesktopToolGrant({ ...ctx, abortSignal: signal }, 'notify')
                    if (!ctx.runId) return JSON.stringify({ inboxStatus: 'not-recorded', status: 'failed', nativeStatus: 'unavailable', reason: 'This notification is not part of an active run.' })
                    const result = await ports.deliver({
                        notificationId: `notify:${ctx.agent.id}:${ctx.sessionId}:${ctx.runId}:${options.toolCallId}`,
                        eventKey: desktopNotifyUserEventKey({ agentId: ctx.agent.id, sessionId: ctx.sessionId, runId: ctx.runId, toolCallId: options.toolCallId }),
                        toolCallId: options.toolCallId,
                        agentId: ctx.agent.id,
                        agentName: ctx.agent.config.name,
                        sessionId: ctx.sessionId,
                        runId: ctx.runId,
                        message,
                        metadata: metadata || ctx.author ? { ...metadata, ...authorMetadata(ctx.author) } : null,
                    }, signal)
                    await requireDesktopToolGrant({ ...ctx, abortSignal: signal }, 'notify')
                    return JSON.stringify(desktopNotifyUserModelReceipt(result))
                } finally { release() }
            },
        }),
    }
}

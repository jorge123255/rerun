import { tool, type ToolSet } from 'ai'
import { z } from 'zod'
import type { RunContext } from '../../runtime/context.js'
import { authorMetadata } from '../../runtime/notify.js'
import { beginDesktopAgentWork } from '../agent-lifecycle.js'
import { hasDesktopToolGrant, requireDesktopToolGrant } from '../tool-grants.js'
import { desktopNotifyUserEventKey, type DesktopNotifyUserAdmission, type DesktopNotifyUserReceipt } from './contract'
import { deliverDesktopUserNotification } from './delivery'

const MAX_MESSAGE_LENGTH = 16_000

export function desktopNotifyTools(ctx: RunContext, ports: { deliver: (input: DesktopNotifyUserAdmission, signal: AbortSignal) => Promise<DesktopNotifyUserReceipt> } = { deliver: deliverDesktopUserNotification }): ToolSet {
    if (!hasDesktopToolGrant(ctx.agent.config, 'notify')) return {}
    return {
        notify_user: tool({
            description:
                'Send the user something they must see out-of-band (they may not be watching this conversation): a result they have to review, a risk you spotted, a decision they should know about. It flags the conversation as unread until they acknowledge it, so reserve it for what genuinely deserves their attention and never use it for a running commentary on your work. Do NOT use it to announce that you finished or that something failed: the end of a run and its errors are notified automatically. This does NOT pause you and does NOT wait for a reply: it only delivers a message, then you keep going. When you need an answer, call ask_user; a go-ahead, request_approval; a service or a credential, suggest_service or request_secret.',
            inputSchema: z.object({
                message: z.string().max(MAX_MESSAGE_LENGTH).describe('The human-readable message to show the user.'),
                kind: z.enum(['info']).default('info').describe('Always info: this tool has exactly one purpose, asking the user to look at something.'),
                metadata: z.record(z.string(), z.any()).optional().describe('Optional structured context (e.g. a URL, a proposed action, options to choose from).'),
            }),
            execute: async ({ message, metadata }, options) => {
                if (!options.toolCallId) throw new Error('notify_user requires a tool call identity.')
                const signal = AbortSignal.any([...(ctx.abortSignal ? [ctx.abortSignal] : []), ...(options.abortSignal ? [options.abortSignal] : []), AbortSignal.timeout(15_000)])
                const release = beginDesktopAgentWork(ctx.agent.id)
                try {
                    await requireDesktopToolGrant({ ...ctx, abortSignal: signal }, 'notify')
                    const result = await ports.deliver({
                        notificationId: `notify:${ctx.agent.id}:${ctx.sessionId}:${ctx.runId ?? 'no-run'}:${options.toolCallId}`,
                        eventKey: desktopNotifyUserEventKey({ agentId: ctx.agent.id, sessionId: ctx.sessionId, runId: ctx.runId ?? null, toolCallId: options.toolCallId }),
                        agentId: ctx.agent.id,
                        agentName: ctx.agent.config.name,
                        sessionId: ctx.sessionId,
                        runId: ctx.runId ?? null,
                        message,
                        metadata: metadata || ctx.author ? { ...metadata, ...authorMetadata(ctx.author) } : null,
                    }, signal)
                    await requireDesktopToolGrant({ ...ctx, abortSignal: signal }, 'notify')
                    return JSON.stringify(result)
                } finally { release() }
            },
        }),
    }
}

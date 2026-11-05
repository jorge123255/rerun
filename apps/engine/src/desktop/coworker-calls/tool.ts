import {
    DESKTOP_COWORKER_CALL_CONTEXT_MAX_CHARS,
    DESKTOP_COWORKER_CALL_MESSAGE_MAX_CHARS,
    DESKTOP_COWORKER_CALL_NAME_MAX_CHARS,
} from '@rerun/contracts'
import { tool, type ToolSet } from 'ai'
import { z } from 'zod'
import type { RunContext } from '../../runtime/context.js'
import type { DesktopCoworkerCallRuntime } from './runtime.js'

// Original call-agent.ts description, without an engine-id roster. An @mention is text, not a grant.
const DESCRIPTION = 'Send a one-shot message to another persistent coworker on this engine. Use it whenever your instructions name another coworker to contact (e.g. @someAgent), including from a scheduled task. The called coworker runs in its own fresh session with its own personality, tools and memory. By default the message is dispatched and you move on without waiting; set wait to true when you need the coworker\'s answer to continue. Use delegate_tasks for subtasks of your own work instead. Use the coworker\'s exact name or local id. Duplicate names are refused. An @mention does not grant access.'

export function desktopCallAgentTools(ctx: RunContext, runtime: DesktopCoworkerCallRuntime): ToolSet {
    return {
        call_agent: tool({
            description: DESCRIPTION,
            inputSchema: z.object({
                agent: z.string().min(1).max(DESKTOP_COWORKER_CALL_NAME_MAX_CHARS).describe('Name or local id of the target coworker'),
                message: z.string().min(1).max(DESKTOP_COWORKER_CALL_MESSAGE_MAX_CHARS).describe('The message to send'),
                context: z.string().max(DESKTOP_COWORKER_CALL_CONTEXT_MAX_CHARS).optional().describe('Optional background the target coworker needs'),
                wait: z.boolean().default(false).describe('Wait for the answer and return it. Default false: dispatch and move on'),
            }),
            execute: async ({ agent, message, context, wait }, { toolCallId, abortSignal }) => {
                // Original call-agent.ts emits one progress part before its first await so rows pair by order.
                ctx.writer?.write({ type: 'data-call-agent', id: toolCallId, data: { agentName: agent, status: 'queued', steps: 0, toolCalls: 0, failures: 0, preview: '', calls: [] } })
                if (!ctx.runId) return 'This run can no longer call a coworker.'
                const result = await runtime.execute({
                    engineAgentId: ctx.agent.id,
                    engineSessionId: ctx.sessionId,
                    engineRunId: ctx.runId,
                    toolCallId,
                    callerName: ctx.agent.config.name,
                    agentRef: agent,
                    message,
                    context,
                    wait,
                    parentSignal: ctx.abortSignal ?? abortSignal,
                    onProgress: snapshot => ctx.writer?.write({ type: 'data-call-agent', id: toolCallId, data: { ...snapshot, agentName: snapshot.targetName } }),
                })
                return result.text
            },
        }),
    }
}

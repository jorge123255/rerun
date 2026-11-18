import { tool, type ToolSet } from 'ai'
import {
    DESKTOP_WORK_REGISTER_TOOL_DESCRIPTIONS, desktopWorkListInputSchema, desktopWorkNoteInputSchema, desktopWorkUpsertInputSchema,
    type DesktopWorkRegisterCall,
} from '@rerun/contracts'
import type { RunContext } from '../../runtime/context.js'
import { beginDesktopAgentWork } from '../agent-lifecycle.js'
import { hasDesktopToolGrant, requireDesktopToolGrant } from '../tool-grants.js'
import { DesktopWorkRegisterRefusal, deliverDesktopWorkRegisterCall } from './delivery.js'

export type DesktopWorkRegisterPorts = { deliver: (call: DesktopWorkRegisterCall, signal: AbortSignal) => Promise<unknown> }

/**
 * work_list, work_upsert and work_note for a coworker or the Chief of Staff with the "Work register"
 * permission. Each call checks the live permission here and sends the run's own identity to the app,
 * which checks it again and keeps the register; nothing is stored in the engine.
 */
export function desktopWorkRegisterTools(ctx: RunContext, ports: DesktopWorkRegisterPorts = { deliver: deliverDesktopWorkRegisterCall }): ToolSet {
    if (ctx.agent.config.ephemeral || !hasDesktopToolGrant(ctx.agent.config, 'workRegister')) return {}
    const run = async (op: DesktopWorkRegisterCall['op'], input: unknown, abortSignal?: AbortSignal) => {
        const signal = AbortSignal.any([...(ctx.abortSignal ? [ctx.abortSignal] : []), ...(abortSignal ? [abortSignal] : []), AbortSignal.timeout(20_000)])
        const release = beginDesktopAgentWork(ctx.agent.id)
        try {
            await requireDesktopToolGrant({ ...ctx, abortSignal: signal }, 'workRegister')
            if (!ctx.runId) return JSON.stringify({ error: 'The work register is only available inside a run.' })
            const caller = { agentId: ctx.agent.id, sessionId: ctx.sessionId, runId: ctx.runId }
            const result = await ports.deliver({ op, caller, input } as DesktopWorkRegisterCall, signal)
            return JSON.stringify(result)
        } catch (error) {
            // A refusal is an answer: the model reads why and decides. Anything else is not known to have happened.
            if (error instanceof DesktopWorkRegisterRefusal) return JSON.stringify({ error: error.message })
            if (error instanceof Error && error.message === 'This tool is turned off for this coworker.') return JSON.stringify({ error: error.message })
            return JSON.stringify({ error: 'The work register did not confirm this call. Read it with work_list before trying again.' })
        } finally { release() }
    }
    return {
        work_list: tool({ description: DESKTOP_WORK_REGISTER_TOOL_DESCRIPTIONS.work_list, inputSchema: desktopWorkListInputSchema, execute: (input, options) => run('list', input, options.abortSignal) }),
        work_upsert: tool({ description: DESKTOP_WORK_REGISTER_TOOL_DESCRIPTIONS.work_upsert, inputSchema: desktopWorkUpsertInputSchema, execute: (input, options) => run('upsert', input, options.abortSignal) }),
        work_note: tool({ description: DESKTOP_WORK_REGISTER_TOOL_DESCRIPTIONS.work_note, inputSchema: desktopWorkNoteInputSchema, execute: (input, options) => run('note', input, options.abortSignal) }),
    }
}

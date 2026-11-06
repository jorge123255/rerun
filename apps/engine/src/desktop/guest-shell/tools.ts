import { createHash } from 'node:crypto'
import { tool, type ToolSet } from 'ai'
import { z } from 'zod'
import { desktopGuestShellInputSchema } from '@rerun/contracts'
import type { RunContext } from '../../runtime/context.js'
import { beginDesktopAgentWork } from '../agent-lifecycle.js'
import { hasDesktopToolGrant } from '../tool-grants.js'
import { createDesktopGuestShellService, type DesktopGuestShellDependencies, type DesktopGuestShellService } from './service.js'
export type { DesktopGuestShellDependencies } from './service.js'

export function guestShellRequestId(agentId: string, sessionId: string, runId: string, toolCallId: string) {
    const hash = createHash('sha256').update(JSON.stringify(['guest-shell-v1', agentId, sessionId, runId, toolCallId])).digest('hex')
    return `${hash.slice(0,8)}-${hash.slice(8,12)}-5${hash.slice(13,16)}-a${hash.slice(17,20)}-${hash.slice(20,32)}`
}
export function desktopGuestShellTools(ctx: RunContext, deps: DesktopGuestShellDependencies, control?: { signal: AbortSignal; track<T>(work: Promise<T>): Promise<T>; authorize(signal: AbortSignal): Promise<void> }): ToolSet {
    if (!hasDesktopToolGrant(ctx.agent.config, 'guestShell')) return {}
    const service = createDesktopGuestShellService(deps)
    async function admitted<T>(optionSignal: AbortSignal | undefined, work: (signal: AbortSignal) => Promise<T>) {
        if (!ctx.abortSignal || !ctx.runId) throw new Error('Guest commands require an active, cancellable run.')
        const signal = AbortSignal.any([ctx.abortSignal, ...(optionSignal ? [optionSignal] : []), ...(control ? [control.signal] : [])])
        signal.throwIfAborted()
        const release = beginDesktopAgentWork(ctx.agent.id)
        const task = (async () => { try { await control?.authorize(signal); const result = await work(signal); await control?.authorize(signal); return result } finally { release() } })()
        return control ? control.track(task) : task
    }
    return {
        shell_exec: tool({
            description: 'Run a bounded command inside this coworker’s isolated computer. This permission can modify guest files, browser data, install software and use its network, but never runs commands on the host Mac. Optional packages must match reviewed installation evidence. Retain the returned request ID to inspect an uncertain outcome; never repeat an uncertain command.',
            inputSchema: desktopGuestShellInputSchema,
            execute: (input, options) => admitted(options.abortSignal, async signal => formatDesktopGuestShellResult(await service.execute({ agentId: ctx.agent.id, sessionId: ctx.sessionId, runId: ctx.runId!, toolCallId: options.toolCallId, requestId: guestShellRequestId(ctx.agent.id, ctx.sessionId, ctx.runId!, options.toolCallId) }, input, signal))),
        }),
        shell_inspect: tool({
            description: 'Read the saved outcome of an earlier isolated command in this conversation. Never executes the command again or starts a stopped computer.',
            inputSchema: z.strictObject({ requestId: z.string().uuid() }),
            execute: (input, options) => admitted(options.abortSignal, async signal => {
                const prior = await service.read(input.requestId)
                if (!prior || prior.identity.agentId !== ctx.agent.id || prior.identity.sessionId !== ctx.sessionId) throw new Error('This command does not belong to this conversation.')
                await control?.authorize(signal)
                return formatDesktopGuestShellResult(await service.inspect(prior.identity, signal))
            }),
        }),
    }
}
export async function desktopGuestShellStop(ctx: RunContext, deps: DesktopGuestShellDependencies, requestId: string) {
    const service = createDesktopGuestShellService(deps), previous = await service.read(requestId)
    if (!previous || previous.identity.agentId !== ctx.agent.id || previous.identity.sessionId !== ctx.sessionId || previous.identity.runId !== ctx.runId) throw new Error('Guest command Stop requires the original invocation.')
    return service.stop(previous.identity, AbortSignal.timeout(25000))
}
export function formatDesktopGuestShellResult(receipt: Awaited<ReturnType<DesktopGuestShellService['execute']>>): string {
    const body = `${receipt.stdout}${receipt.stderr ? `\n[stderr]\n${receipt.stderr}` : ''}`
    const header = `Command request: ${receipt.requestId}\nStatus: ${receipt.status}\n`
    if (receipt.status === 'done') return header + (body || '(no output)')
    if (receipt.status === 'timeout') return `${header}Command timed out\n${body}`
    if (receipt.status === 'cancelled') return `${header}Command cancelled\n${body}`
    if (receipt.status === 'failed') return `${header}Command failed${receipt.exitCode === null ? '' : ` (exit ${receipt.exitCode})`}\n${body}`
    if (receipt.status === 'unavailable') return `${header}Command outcome is unavailable\n${receipt.message ?? body}`
    return `${header}Command interrupted: inspect this request instead of executing it again.\n${receipt.message ?? body}`
}

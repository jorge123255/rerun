import { tool, type ToolSet } from 'ai'
import { desktopGuestShellInputSchema } from '@rerun/contracts'
import type { RunContext } from '../../runtime/context.js'
import { beginDesktopAgentWork } from '../agent-lifecycle.js'
import { hasDesktopToolGrant } from '../tool-grants.js'
import type { DesktopGuestShellAuthority, DesktopGuestShellPackageAuthority, DesktopGuestShellStore, DesktopGuestShellTransport } from './types.js'
import { createDesktopGuestShellService } from './service.js'

export type DesktopGuestShellDependencies = {
    authority: DesktopGuestShellAuthority
    transport: DesktopGuestShellTransport
    store: DesktopGuestShellStore
    packageAuthority?: DesktopGuestShellPackageAuthority
}

const grant = 'guestShell' as Parameters<typeof hasDesktopToolGrant>[1]

export function desktopGuestShellTools(ctx: RunContext, deps: DesktopGuestShellDependencies): ToolSet {
    if (!hasDesktopToolGrant(ctx.agent.config, grant)) return {}
    const service = createDesktopGuestShellService(deps)
    return {
        shell_exec: tool({
            description: 'Run a bounded shell command inside this coworker’s isolated guest workspace. Commands use only the reviewed guest packages and minimal environment, never the host or its credentials. Stop or timeout returns the actual outcome; uncertain outcomes are inspected rather than replayed.',
            inputSchema: desktopGuestShellInputSchema,
            execute: async (input, options) => {
                const signal = ctx.abortSignal ?? options.abortSignal
                if (!signal || !ctx.runId) throw new Error('Guest commands require an active, cancellable run.')
                signal.throwIfAborted()
                const release = beginDesktopAgentWork(ctx.agent.id)
                try {
                    return formatDesktopGuestShellResult(await service.execute({
                        agentId: ctx.agent.id,
                        sessionId: ctx.sessionId,
                        runId: ctx.runId,
                        toolCallId: options.toolCallId,
                        requestId: options.toolCallId,
                    }, input, signal)
                } finally { release() }
            },
        }),
    }
}

export function desktopGuestShellStop(ctx: RunContext, deps: DesktopGuestShellDependencies, requestId: string) {
    if (!ctx.runId || !ctx.abortSignal) throw new Error('Guest command Stop requires the current run and original request ID.')
    return createDesktopGuestShellService(deps).stop({
        agentId: ctx.agent.id,
        sessionId: ctx.sessionId,
        runId: ctx.runId,
        toolCallId: requestId,
        requestId,
    }, ctx.abortSignal)
}

export function formatDesktopGuestShellResult(receipt: Awaited<ReturnType<DesktopGuestShellService['execute']>): string {
    const body = `${receipt.stdout}${receipt.stderr ? `\n[stderr]\n${receipt.stderr}` : ''}`
    if (receipt.status === 'done') return body || '(no output)'
    if (receipt.status === 'timeout') return `Command timed out\n${body}`
    if (receipt.status === 'cancelled') return `Command cancelled\n${body}`
    if (receipt.status === 'failed') return `Command failed${receipt.exitCode === null ? '' : ` (exit ${receipt.exitCode})`}\n${body}`
    if (receipt.status === 'unavailable') return `Command outcome is unavailable\n${receipt.message ?? body}`
    return `Command interrupted: inspect the same guest request instead of executing it again.\n${receipt.message ?? body}`
}

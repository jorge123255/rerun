import { tool, type ToolSet } from 'ai'
import { z } from 'zod'
import { SELF_MCP_GRANT, selfMcpInputIssue, selfMcpProposalInput, selfMcpResolvedTransport, type DesktopRerunGrantId } from '@rerun/contracts'
import type { RunContext } from '../../runtime/context.js'
import { withAgentLock } from '../../agents/lock.js'
import { beginDesktopAgentWork } from '../agent-lifecycle.js'
import { requireDesktopToolGrant } from '../tool-grants.js'
import { selfMcpFingerprint } from './fingerprint.js'
import { proposeSelfMcp } from './bridge.js'

const GRANT: DesktopRerunGrantId = SELF_MCP_GRANT
const REFUSAL = 'Nothing was proposed or saved.'

// The Mac slice of the hosted mcp_register workflow: the model may propose an MCP
// server, and nothing more. Proposing reserves a review proposal through the UI
// service — it never opens a network connection to the server, never changes
// configuration, never installs a package and never launches a local program.
// Registration and tool execution stay distinct decisions: only an explicit
// local human decision may probe and save, behind the existing MCP
// configuration and transport adapters plus the separate local-program grant.
export function desktopSelfMcpTools(ctx: RunContext): ToolSet {
    // Snapshot gate: the fresh check below is authoritative. The default-off
    // per-coworker grant is read raw so the tool stays closed before the grants
    // wiring lands, and the existing Improve-itself master applies here too.
    const grants = ctx.agent.config.tools.desktopToolGrants as Record<string, boolean | undefined> | undefined
    if (!ctx.agent.config.enabled || ctx.agent.config.ephemeral || grants?.selfMcpRegister !== true) return {}
    if (!ctx.agent.config.selfImprovement.enabled) return {}
    if (!ctx.runId || !ctx.abortSignal) throw new Error('Self-MCP requires an active, cancellable run')
    const runSignal = ctx.abortSignal
    const runId = ctx.runId

    const tools: ToolSet = {}
    tools.mcp_register = tool({
        description:
            'Propose an MCP server for this coworker. Supports stdio (command), sse and http (url). Transport is auto-detected from the url/command if omitted. Pass headers for bearer-token auth as ${NAME} references to coworker variables (e.g. "Authorization": "Bearer ${LINEAR_API_KEY}"); never inline a raw credential. Your proposal is not saved, connected or executed: a review card waits in the Mac app and only a human decision there may probe and save it, behind the MCP and local-program permissions. Package installation is out of scope.',
        inputSchema: z.object({
            name: z.string(),
            transport: z.enum(['stdio', 'sse', 'http']).nullish(),
            command: z.string().nullish(),
            args: z.array(z.string()).default([]),
            url: z.string().nullish(),
            env: z.record(z.string(), z.string()).default({}).describe('Environment entries as ${NAME} credential references only.'),
            headers: z.record(z.string(), z.string()).default({}).describe('HTTP headers for auth as ${NAME} references to coworker variables, e.g. { "Authorization": "Bearer ${LINEAR_API_KEY}" }'),
        }),
        execute: async (input, options) => {
            const signal = AbortSignal.any([runSignal, ...(options.abortSignal ? [options.abortSignal] : [])])
            signal.throwIfAborted()
            if (!options.toolCallId || options.toolCallId.length > 256) throw new Error('Invalid MCP invocation')
            const name = typeof input.name === 'string' ? input.name : ''
            const candidate = { name, transport: input.transport ?? undefined, command: input.command ?? undefined, args: input.args ?? [], url: input.url ?? undefined, headers: input.headers ?? {}, env: input.env ?? {} }
            // Strict nonsecret validation is pure and precedes every effect: invalid proposals
            // (reserved/invalid names, inline credentials, credential-bearing urls, raw env
            // secrets, unrecognized fields) never reach the bridge, never open a connection and
            // never write anything.
            const issue = selfMcpInputIssue(candidate)
            if (issue) return `${issue}\n${REFUSAL}`
            const parsed = selfMcpProposalInput(candidate)
            if (!parsed) return `Could not propose MCP server "${name}".\n${REFUSAL}`
            // Fresh admission: permission changes, revocations and Stop share the lock, so a
            // waiting call must read the grant again after an earlier revoke has taken effect.
            await withAgentLock(ctx.agent.id, async () => {
                await requireDesktopToolGrant(ctx, GRANT)
            })
            const release = beginDesktopAgentWork(ctx.agent.id)
            try {
                const fingerprint = selfMcpFingerprint(parsed)
                const result = await proposeSelfMcp(
                    { engineAgentId: ctx.agent.id, sessionId: ctx.sessionId, runId, toolCallId: options.toolCallId },
                    fingerprint,
                    parsed,
                    signal,
                )
                const transport = selfMcpResolvedTransport(parsed)
                if (result.outcome === 'proposed') {
                    return `Proposed MCP server "${name}" (${transport}). A review card is waiting in the Mac app — nothing is saved, connected or executed until a human approves it there.`
                }
                if (result.outcome === 'reconciled') {
                    return `A proposal for MCP server "${name}" from this call is already under review. A review card is waiting in the Mac app.`
                }
                if (result.outcome === 'conflict') {
                    return `Could not propose MCP server "${name}": a different proposal from this call already exists and cannot be replaced. Refresh the review card or start a new call.\n${REFUSAL}`
                }
                return `Could not propose MCP server "${name}": ${result.message}\n${REFUSAL}`
            } finally {
                release()
            }
        },
    })
    return tools
}

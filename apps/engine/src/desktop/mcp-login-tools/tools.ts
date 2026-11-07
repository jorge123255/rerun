import { tool, type ToolSet } from 'ai'
import { z } from 'zod'
import type { RunContext } from '../../runtime/context.js'
import { abortable } from '../web-fetch/transport.js'
import { desktopInternalJson } from '../internal-client.js'
import { hasDesktopToolGrant, requireDesktopToolGrant } from '../tool-grants.js'
import { desktopMcpSignInTools } from '../mcp-sign-in/request-sign-in.js'
import { markMcpLoginTool } from './admission.js'
import { loginIdentitySchema, loginNameSchema, loginRequestSchema, loginResponseSchema, safeVerificationUri, MCP_LOGIN_BRIDGE_PATH, type LoginRequest, type LoginResponse } from './contract.js'

export type LoginToolPort = {
    authorize(signal: AbortSignal): Promise<void>
    call(request: LoginRequest, signal: AbortSignal): Promise<unknown>
}

function render(response: LoginResponse): string {
    const result = response.result
    if (result.action === 'status') return result.servers.length ? result.servers.map(row => {
        if (row.status === 'connected') return `connected ${row.name} (${row.transport}): ${row.tools.length} tools reported by the server — ${row.tools.join(', ')}`
        return `${row.status} ${row.name} (${row.transport}): ${row.reason === 'permission_required' ? 'separate permission required' : row.reason === 'transport_unavailable' ? 'status adapter unavailable' : 'check permission, configuration and server'}`
    }).join('\n') : 'No HTTPS MCP servers registered. Local MCP programs use a separate permission and status.'
    const { name, view } = result
    if (view.state === 'waiting') return `Ask the user to open this URL and sign in to "${name}":\n${safeVerificationUri(view.verificationUri)}\nThe link is valid for about ${Math.round(view.expiresIn / 60)} minutes. Once the user confirms they have signed in, call mcp_login_complete with name "${name}".`
    if (view.state === 'connected') return `Signed in to "${name}". ${view.tools.length} tools now available: ${view.tools.join(', ')}. Active from your next message onward.`
    if (view.state === 'no_pending') return `No pending sign-in for "${name}". Call mcp_login first.`
    if (view.state === 'approval_required') return `Sign-in to "${name}" requires the user's approval. Call request_mcp_sign_in with name "${name}" and end your turn.`
    if (view.state === 'unsupported') return `Device-code sign-in for "${name}" is unavailable in this desktop runtime. Use request_mcp_sign_in and the human Connect card. No authorization was started.`
    if (view.state === 'unknown') return `Sign-in outcome for "${name}" is unknown. Do not repeat authorization; reconcile the existing attempt in MCP servers.`
    if (view.state === 'pending') return `Sign-in not finished for "${name}": still waiting for sign-in — finish opening the link, then try again.`
    return `Sign-in not finished for "${name}". Check the existing attempt in MCP servers.`
}

export function createDesktopMcpLoginTools(identity: LoginRequest['identity'], runSignal: AbortSignal, port: LoginToolPort): ToolSet {
    const owner = loginIdentitySchema.parse(identity)
    async function execute(action: LoginRequest['action'], name: string | undefined, options: { toolCallId: string; abortSignal?: AbortSignal }) {
        const signal = AbortSignal.any([runSignal, ...(options.abortSignal ? [options.abortSignal] : []), AbortSignal.timeout(70_000)])
        signal.throwIfAborted()
        const request = loginRequestSchema.parse({ action, identity: owner, toolCallId: options.toolCallId, ...(name === undefined ? {} : { name }) })
        await abortable(port.authorize(signal), signal); signal.throwIfAborted()
        let raw: unknown
        try { raw = await abortable(port.call(request, signal), signal) }
        catch { throw new Error(action === 'status' ? 'MCP status is unavailable.' : 'MCP sign-in acknowledgement is unavailable. Do not retry authorization; reconcile the existing attempt in MCP servers.') }
        const response = loginResponseSchema.parse(raw)
        await abortable(port.authorize(signal), signal); signal.throwIfAborted()
        if (JSON.stringify(response.identity) !== JSON.stringify(owner) || response.toolCallId !== request.toolCallId || response.result.action !== action || response.result.action !== 'status' && response.result.name !== name) throw new Error('MCP login response identity changed')
        return render(response)
    }
    const tools: ToolSet = {
        mcp_login: tool({ description: 'Fallback device-code sign-in for a registered MCP server, only with a separately recorded human approval. First use request_mcp_sign_in and its Connect card. Never supply a URL, credential or approval yourself.', inputSchema: z.object({ name: loginNameSchema }).strict(), execute: (input, options) => execute('start', input.name, options) }),
        mcp_login_complete: tool({ description: 'Reconcile a pending device-code sign-in only after the user confirms completion. Never treats a saved credential or an uncertain acknowledgement as a working connection.', inputSchema: z.object({ name: loginNameSchema }).strict(), execute: (input, options) => execute('complete', input.name, options) }),
        mcp_status: tool({ description: 'Check configured HTTPS MCP connections and the tool names reported by each server. Reported tools may be unavailable in the current run. Does not include local programs, start authorization, install servers or execute their tools.', inputSchema: z.object({}).strict(), execute: (_input, options) => execute('status', undefined, options) }),
    }
    for (const name of ['mcp_login', 'mcp_login_complete', 'mcp_status'] as const) markMcpLoginTool(tools[name]!, owner.engineAgentId, name)
    return tools
}

export function desktopMcpLoginTools(ctx: RunContext): ToolSet {
    if (!ctx.runId || !ctx.abortSignal || !ctx.agent.config.enabled || ctx.agent.config.ephemeral || !hasDesktopToolGrant(ctx.agent.config, 'mcp')) return {}
    const tools = createDesktopMcpLoginTools({ engineAgentId: ctx.agent.id, sessionId: ctx.sessionId, runId: ctx.runId }, ctx.abortSignal, {
        authorize: async signal => { signal.throwIfAborted(); await requireDesktopToolGrant(ctx, 'mcp'); signal.throwIfAborted() },
        call: (request, signal) => desktopInternalJson(MCP_LOGIN_BRIDGE_PATH, request, signal, 96_000),
    })
    const human = desktopMcpSignInTools(ctx)
    if (human.request_mcp_sign_in) tools.request_mcp_sign_in = markMcpLoginTool(human.request_mcp_sign_in, ctx.agent.id, 'request_mcp_sign_in')
    return tools
}

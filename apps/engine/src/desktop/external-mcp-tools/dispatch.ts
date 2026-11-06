import { externalMcpCallContextSchema, externalMcpPrincipalSchema, type ExternalMcpDispatchPort, type ExternalMcpLiveCheckInput, type ExternalMcpLiveCheckResult, type ExternalMcpPrincipal, type ExternalMcpScope, type ExternalMcpToolRegistration } from '@rerun/contracts'

export type ExternalMcpInvokeBinding = {
    tools: ExternalMcpToolRegistration[]
    recheck(input: ExternalMcpLiveCheckInput): Promise<ExternalMcpLiveCheckResult>
    invoke(context: Parameters<ExternalMcpDispatchPort['callTool']>[0], signal: AbortSignal): Promise<unknown>
}

function hasScope(principal: ExternalMcpPrincipal, scope: ExternalMcpScope) {
    return principal.scopes.includes(scope)
}

function available(tool: ExternalMcpToolRegistration, principal: ExternalMcpPrincipal) {
    return hasScope(principal, tool.scope) && (tool.name !== 'create_agent' || hasScope(principal, 'runs:send'))
}

/** Full B ExternalMcpDispatchPort for reads and scoped effects. B owns effect receipts around this port. */
export function createExternalMcpDispatch(binding: ExternalMcpInvokeBinding): ExternalMcpDispatchPort {
    if (binding.tools.some(tool => tool.effect ? tool.scope === 'mcp:read' : tool.scope !== 'mcp:read')) {
        throw new Error('Tool scope/effect pairing is invalid.')
    }
    const tools = structuredClone(binding.tools)
    const byName = new Map(tools.map(tool => [tool.name, tool]))
    const check = async (principal: ExternalMcpPrincipal, requestId: string, signal: AbortSignal, required?: ExternalMcpScope) => {
        signal.throwIfAborted()
        const { keyId, workspaceId, keyRevision, installId, launchNonce } = externalMcpPrincipalSchema.parse(principal)
        if (required && !hasScope(principal, required)) throw new Error(`Missing scope ${required}.`)
        if (!required && !hasScope(principal, 'mcp:read') && !principal.scopes.some(scope => scope !== 'mcp:read')) {
            throw new Error('No authorized external scopes.')
        }
        const result = await binding.recheck({ keyId, workspaceId, keyRevision, installId, launchNonce, requestId, scopes: [...principal.scopes] })
        signal.throwIfAborted()
        if (!result.ok) throw new Error('External MCP authority is no longer current.')
        return result.principal
    }
    return {
        async listTools(principal) {
            await check(principal, crypto.randomUUID(), AbortSignal.timeout(15_000))
            return structuredClone(tools.filter(tool => available(tool, principal)))
        },
        async callTool(raw, signal) {
            const context = externalMcpCallContextSchema.parse(raw)
            const linked = AbortSignal.any([signal, AbortSignal.timeout(600_000)])
            const tool = byName.get(context.tool)
            if (!tool) throw new Error('Unsupported external tool.')
            if (!available(tool, context.principal)) throw new Error('Missing scope for this external tool.')
            await check(context.principal, context.requestId, linked, tool.scope)
            const result = await binding.invoke(context, linked)
            await check(context.principal, context.requestId, linked, tool.scope)
            const text = JSON.stringify(result)
            if (typeof text !== 'string' || new TextEncoder().encode(text).length > 60_000) throw new Error('Result is too large. Narrow this request.')
            return { content: [{ type: 'text', text }], structuredContent: result }
        },
    }
}

/** @deprecated Prefer createExternalMcpDispatch. Kept for the initial five-read adapter and its regressions. */
export type ExternalReadBinding = {
    tools: ExternalMcpToolRegistration[]
    recheck(input: ExternalMcpLiveCheckInput): Promise<ExternalMcpLiveCheckResult>
    read(context: Parameters<ExternalMcpDispatchPort['callTool']>[0], signal: AbortSignal): Promise<unknown>
}
export function createExternalReadDispatch(binding: ExternalReadBinding): ExternalMcpDispatchPort {
    if (binding.tools.some(tool => tool.effect || tool.scope !== 'mcp:read')) throw new Error('Read adapter cannot register effects.')
    return createExternalMcpDispatch({ tools: binding.tools, recheck: binding.recheck, invoke: binding.read })
}

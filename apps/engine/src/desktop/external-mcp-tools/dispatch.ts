import { externalMcpCallContextSchema, externalMcpPrincipalSchema, type ExternalMcpDispatchPort, type ExternalMcpLiveCheckInput, type ExternalMcpLiveCheckResult, type ExternalMcpPrincipal, type ExternalMcpToolRegistration } from '@rerun/contracts'

export type ExternalReadBinding = {
    tools: ExternalMcpToolRegistration[]
    recheck(input: ExternalMcpLiveCheckInput): Promise<ExternalMcpLiveCheckResult>
    read(context: Parameters<ExternalMcpDispatchPort['callTool']>[0], signal: AbortSignal): Promise<unknown>
}
export function createExternalReadDispatch(binding: ExternalReadBinding): ExternalMcpDispatchPort {
    if (binding.tools.some(tool => tool.effect || tool.scope !== 'mcp:read')) throw new Error('Read adapter cannot register effects.')
    const tools = structuredClone(binding.tools)
    const check = async (principal: ExternalMcpPrincipal, requestId: string, signal: AbortSignal) => {
        signal.throwIfAborted()
        const { keyId, workspaceId, keyRevision, installId, launchNonce } = externalMcpPrincipalSchema.parse(principal)
        if (!principal.scopes.includes('mcp:read')) throw new Error('Read scope is required.')
        const result = await binding.recheck({ keyId, workspaceId, keyRevision, installId, launchNonce, requestId, scopes: [...principal.scopes] })
        signal.throwIfAborted()
        if (!result.ok) throw new Error('External MCP authority is no longer current.')
    }
    return {
        async listTools(principal) {
            await check(principal, crypto.randomUUID(), AbortSignal.timeout(15_000))
            return structuredClone(tools)
        },
        async callTool(raw, signal) {
            const context = externalMcpCallContextSchema.parse(raw)
            const linked = AbortSignal.any([signal, AbortSignal.timeout(15_000)])
            await check(context.principal, context.requestId, linked)
            if (!tools.some(tool => tool.name === context.tool)) throw new Error('Unsupported external tool.')
            const result = await binding.read(context, linked)
            await check(context.principal, context.requestId, linked)
            const text = JSON.stringify(result)
            if (typeof text !== 'string' || new TextEncoder().encode(text).length > 60_000) throw new Error('Result is too large. Narrow this request.')
            return { content: [{ type: 'text', text }], structuredContent: result }
        },
    }
}

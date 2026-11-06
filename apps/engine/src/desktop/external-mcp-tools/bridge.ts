import {
    EXTERNAL_MCP_TOOLS_INTERNAL_PATH, externalMcpCallContextSchema, externalMcpPrincipalSchema,
    externalMcpToolRegistrationSchema, externalMcpToolResultSchema,
    type ExternalMcpDispatchPort, type ExternalMcpLiveCheckInput, type ExternalMcpLiveCheckResult,
    type ExternalMcpPrincipal,
} from '@rerun/contracts'
import { desktopInternalJson } from '../internal-client.js'

export function createExternalMcpUiDispatch(options: {
    recheck(input: ExternalMcpLiveCheckInput): Promise<ExternalMcpLiveCheckResult>
}): ExternalMcpDispatchPort {
    async function check(principal: ExternalMcpPrincipal, requestId: string, signal: AbortSignal) {
        signal.throwIfAborted()
        const { keyId, workspaceId, keyRevision, installId, launchNonce, scopes } = externalMcpPrincipalSchema.parse(principal)
        const result = await options.recheck({ keyId, workspaceId, keyRevision, installId, launchNonce, scopes, requestId })
        signal.throwIfAborted()
        if (!result.ok) throw new Error('External MCP authority changed.')
    }
    return {
        async listTools(principal) {
            const signal = AbortSignal.timeout(15_000), requestId = crypto.randomUUID()
            await check(principal, requestId, signal)
            const result = await desktopInternalJson(EXTERNAL_MCP_TOOLS_INTERNAL_PATH, { action: 'list', principal }, signal, 1_100_000)
            await check(principal, requestId, signal)
            return externalMcpToolRegistrationSchema.array().parse(result)
        },
        async callTool(raw, stop) {
            const context = externalMcpCallContextSchema.parse(raw)
            const signal = AbortSignal.any([stop, AbortSignal.timeout(600_000)])
            await check(context.principal, context.requestId, signal)
            const result = await desktopInternalJson(EXTERNAL_MCP_TOOLS_INTERNAL_PATH, { action: 'call', context }, signal, 200_000)
            await check(context.principal, context.requestId, signal)
            return externalMcpToolResultSchema.parse(result)
        },
    }
}

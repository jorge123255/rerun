import 'server-only'
import type { ExternalMcpDispatchPort, ExternalMcpLiveCheckInput, ExternalMcpLiveCheckResult } from '@rerun/contracts'
import { createExternalMcpDispatch } from '../../../../../engine/src/desktop/external-mcp-tools/dispatch'
import { externalMcpToolRegistrations } from './catalog'
import { invokeExternalMcpOperation, type ExternalMcpServicesAuthority } from './operations'

export type CreateLocalExternalMcpToolsOptions = {
    recheck: (input: ExternalMcpLiveCheckInput) => Promise<ExternalMcpLiveCheckResult>
    services?: ExternalMcpServicesAuthority
}

/** Full C-owned external MCP catalog bound to local desktop authorities. */
export function createLocalExternalMcpTools(options: CreateLocalExternalMcpToolsOptions): ExternalMcpDispatchPort {
    const servicesBound = Boolean(options.services)
    return createExternalMcpDispatch({
        tools: externalMcpToolRegistrations({ servicesBound }),
        recheck: options.recheck,
        async invoke(context, signal) {
            try {
                return await invokeExternalMcpOperation(context, signal, { recheck: options.recheck, services: options.services })
            } catch (error) {
                throw error instanceof Error ? error : new Error('External tool failed.')
            }
        },
    })
}

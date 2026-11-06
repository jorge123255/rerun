import 'server-only'
import type { ExternalMcpDispatchPort, ExternalMcpLiveCheckInput, ExternalMcpLiveCheckResult } from '@rerun/contracts'
import { createLocalExternalMcpTools } from './factory'

/**
 * Historical five-read entry point. Now returns the full C catalog so older activation
 * fragments keep working; prefer createLocalExternalMcpTools for new wiring.
 */
export function createLocalExternalReadTools(recheck: (input: ExternalMcpLiveCheckInput) => Promise<ExternalMcpLiveCheckResult>): ExternalMcpDispatchPort {
    return createLocalExternalMcpTools({ recheck })
}

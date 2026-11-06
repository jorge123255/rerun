import type { ExternalMcpCreateInput, ExternalMcpCreateResult, ExternalMcpEnableInput, ExternalMcpListResult, ExternalMcpListenerResult, ExternalMcpListenerView, ExternalMcpRevokeInput, ExternalMcpRevokeResult } from '@rerun/contracts'
import type { DesktopExternalMcpAttempt } from './attempts'

export type DesktopExternalMcpDriver = {
    list(workspaceId: number, signal: AbortSignal): Promise<ExternalMcpListResult>
    listener(signal: AbortSignal): Promise<ExternalMcpListenerView>
    create(input: ExternalMcpCreateInput, signal: AbortSignal): Promise<ExternalMcpCreateResult>
    revoke(input: ExternalMcpRevokeInput, signal: AbortSignal): Promise<ExternalMcpRevokeResult>
    enable(input: ExternalMcpEnableInput, signal: AbortSignal): Promise<ExternalMcpListenerResult>
    disable(input: ExternalMcpEnableInput, signal: AbortSignal): Promise<ExternalMcpListenerResult>
    attempts: {
        list(workspaceId: number, signal: AbortSignal): Promise<DesktopExternalMcpAttempt[]>
        reserve(attempt: DesktopExternalMcpAttempt, signal: AbortSignal): Promise<DesktopExternalMcpAttempt>
        clear(attempt: DesktopExternalMcpAttempt, signal: AbortSignal): Promise<void>
    }
}

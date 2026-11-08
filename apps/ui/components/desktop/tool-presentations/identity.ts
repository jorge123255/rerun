import type { DesktopHistoricalIdentity } from './status'

export function historicalIdentityProps(identity: DesktopHistoricalIdentity, toolCallId: string) {
    return {
        'data-owner': identity.ownerId ?? '',
        'data-workspace': identity.workspaceId ?? '',
        'data-run': identity.runId ?? '',
        'data-tool-call-id': toolCallId,
        'data-effect': 'none',
    } as const
}

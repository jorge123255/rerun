import type { MacPhoneCoworkerSetup } from '@rerun/mac-contracts/mac-phone-pairing'

export type PairedInstallStatus = 'unknown' | 'started' | 'skipped' | 'complete'

// Install metadata in the transcript identifies a guide. Only the Mac's setup record identifies
// the coworker and conversation it belongs to, and whether setup ultimately finished.
export function pairedInstallStatus(view: MacPhoneCoworkerSetup | null | undefined, agentId: string, sessionId: string | null): PairedInstallStatus {
    if (!view || !sessionId || view.agentId !== agentId || view.sessionId !== sessionId) return 'unknown'
    if (view.completedAt) return 'complete'
    if (view.skipped) return 'skipped'
    return view.pending ? 'started' : 'unknown'
}

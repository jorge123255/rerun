import { desktopWorkspaceIdSchema, type DesktopWorkspaceRefusalCode } from '@rerun/contracts'
import type { DesktopOverviewIdentity } from './identity'

export const DESKTOP_OVERVIEW_WORKSPACE_COPY = {
    notFound: 'That workspace is not available on this Mac.',
    busy: 'A workspace switch is already in progress. Wait for it to finish, then try again.',
    draftFlushFailed: 'Unsent drafts could not be saved. Stay in this workspace to keep them, then try switching again.',
    identityMismatch: 'The workspace that started does not match the one you selected.',
    quitInProgress: 'Rerun is quitting, so the workspace cannot change right now.',
    runActive: 'A reply is still open for this coworker. Stay in this workspace until it finishes. Nothing was switched.',
    runUnknown: 'This coworker’s reply status is unavailable. Nothing was switched.',
} as const

export type DesktopOverviewRunBoundary = 'idle' | 'active' | 'unknown'

export type DesktopOverviewFlush =
    | { saved: true; ownerId: string; workspaceId: number }
    | { saved: false }
    | { saved: 'unknown' }

export type DesktopOverviewWorkspaceDecision =
    | { ok: true; effect: 'none' | 'switch'; workspaceId: number }
    | { ok: false; code: DesktopWorkspaceRefusalCode | 'run_boundary'; message: string }

export function decideDesktopOverviewWorkspaceSwitch(input: {
    identity: DesktopOverviewIdentity
    targetWorkspaceId: number
    flush: DesktopOverviewFlush
    switchInFlight: boolean
    quitting: boolean
    runBoundary: DesktopOverviewRunBoundary
}): DesktopOverviewWorkspaceDecision {
    if (!desktopWorkspaceIdSchema.safeParse(input.targetWorkspaceId).success) {
        return { ok: false, code: 'not_found', message: DESKTOP_OVERVIEW_WORKSPACE_COPY.notFound }
    }
    if (input.quitting) return { ok: false, code: 'quit_in_progress', message: DESKTOP_OVERVIEW_WORKSPACE_COPY.quitInProgress }
    if (input.switchInFlight) return { ok: false, code: 'busy', message: DESKTOP_OVERVIEW_WORKSPACE_COPY.busy }
    if (input.targetWorkspaceId === input.identity.workspaceId) return { ok: true, effect: 'none', workspaceId: input.identity.workspaceId }
    if (input.runBoundary === 'active') return { ok: false, code: 'run_boundary', message: DESKTOP_OVERVIEW_WORKSPACE_COPY.runActive }
    if (input.runBoundary !== 'idle') return { ok: false, code: 'run_boundary', message: DESKTOP_OVERVIEW_WORKSPACE_COPY.runUnknown }
    if (input.flush.saved !== true) return { ok: false, code: 'draft_flush_failed', message: DESKTOP_OVERVIEW_WORKSPACE_COPY.draftFlushFailed }
    if (input.flush.ownerId !== input.identity.ownerId || input.flush.workspaceId !== input.identity.workspaceId) {
        return { ok: false, code: 'identity_mismatch', message: DESKTOP_OVERVIEW_WORKSPACE_COPY.identityMismatch }
    }
    return { ok: true, effect: 'switch', workspaceId: input.targetWorkspaceId }
}

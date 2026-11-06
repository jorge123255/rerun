import 'server-only'
import type { DesktopScheduleRecord, DesktopWorkspaceRoutineMutation, DesktopWorkspaceRoutineMutationResult } from '../../../../../../packages/contracts/src/desktop-workspace-routines'
import { DesktopHttpError } from '../auth'

export type DesktopWorkspaceRoutinesMutationAuthority = {
    current: (agentId: string, slug: string, signal?: AbortSignal) => Promise<DesktopScheduleRecord>
    authorize: (agentId: string, signal?: AbortSignal) => Promise<void>
    receipt: (requestId: string, signal?: AbortSignal) => Promise<DesktopWorkspaceRoutineMutationResult | null>
    mutate: (input: DesktopWorkspaceRoutineMutation, signal?: AbortSignal) => Promise<DesktopWorkspaceRoutineMutationResult>
}

export function createDesktopWorkspaceRoutinesMutator(authority: DesktopWorkspaceRoutinesMutationAuthority) {
    async function validate(input: DesktopWorkspaceRoutineMutation, signal?: AbortSignal): Promise<DesktopScheduleRecord> {
        signal?.throwIfAborted()
        const before = await authority.current(input.agentId, input.slug, signal)
        if (before.revision !== input.expectedRevision) throw new DesktopHttpError(409, 'This routine changed. Refresh it before saving.')
        await authority.authorize(input.agentId, signal)
        const after = await authority.current(input.agentId, input.slug, signal)
        if (after.revision !== before.revision) throw new DesktopHttpError(409, 'This routine changed while the change was being checked. Refresh it before saving.')
        signal?.throwIfAborted()
        return after
    }

    async function perform(input: DesktopWorkspaceRoutineMutation, signal?: AbortSignal): Promise<DesktopWorkspaceRoutineMutationResult> {
        const existing = await authority.receipt(input.requestId, signal)
        if (existing) return existing
        await validate(input, signal)
        const result = await authority.mutate(input, signal)
        if (input.action === 'rename' && result.routine.name !== input.name.trim()) throw new DesktopHttpError(409, 'Update this coworker to rename its routines.')
        return result
    }

    return {
        rename: (input: Extract<DesktopWorkspaceRoutineMutation, { action: 'rename' }>, signal?: AbortSignal) => perform(input, signal),
        toggle: (input: Extract<DesktopWorkspaceRoutineMutation, { action: 'toggle' }>, signal?: AbortSignal) => perform(input, signal),
        run: (input: Extract<DesktopWorkspaceRoutineMutation, { action: 'run' }>, signal?: AbortSignal) => perform(input, signal),
        edit: (input: Extract<DesktopWorkspaceRoutineMutation, { action: 'edit' }>, signal?: AbortSignal) => perform(input, signal),
    }
}

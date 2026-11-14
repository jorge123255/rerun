import 'server-only'
import { createHash } from 'node:crypto'
import { desktopWorkspaceRoutineMutationSchema } from '@rerun/contracts'
import type { DesktopScheduleRecord, DesktopWorkspaceRoutineMutation, DesktopWorkspaceRoutineMutationResult } from '@rerun/contracts'
import { DesktopHttpError } from '../auth'

export type DesktopWorkspaceRoutinesMutationAuthority = {
    current: (agentId: string, slug: string, signal?: AbortSignal) => Promise<DesktopScheduleRecord>
    authorize: (agentId: string, signal?: AbortSignal) => Promise<void>
    receipt: (input: DesktopWorkspaceRoutineMutation, signal?: AbortSignal) => Promise<{ fingerprint: string; result: DesktopWorkspaceRoutineMutationResult | null; reserved?: boolean } | null>
    mutate: (input: DesktopWorkspaceRoutineMutation, signal?: AbortSignal) => Promise<DesktopWorkspaceRoutineMutationResult>
}

export function desktopWorkspaceRoutineFingerprint(input: DesktopWorkspaceRoutineMutation) {
    return createHash('sha256').update(JSON.stringify(desktopWorkspaceRoutineMutationSchema.parse(input))).digest('hex')
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
        const existing = await authority.receipt(input, signal)
        if (existing) {
            if (existing.fingerprint !== desktopWorkspaceRoutineFingerprint(input)) throw new DesktopHttpError(409, 'This request belongs to another routine change.')
            if (existing.result) return existing.result
            if (existing.reserved) return authority.mutate(input, signal)
        }
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

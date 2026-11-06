import {
    desktopCoworkerShareMemoryPackageSchema,
    desktopCoworkerShareMemoryRestoreResultSchema,
    type DesktopCoworkerShareMemoryNote,
    type DesktopCoworkerShareMemoryPackage,
    type DesktopCoworkerShareMemoryRestoreResult,
} from '../../../../../packages/contracts/src/desktop-coworker-share-memory.ts'
import { DesktopCoworkerShareMemoryError } from './errors.ts'
import { digestNoteContent, packageDigest } from './serialize.ts'

export type DesktopCoworkerShareMemoryInstallAuthority = {
    workspaceId: number
    destinationAgentId: string
    /** Destination must be a fresh coworker with no existing owned notes. */
    assertFreshDestination: () => Promise<void>
    /**
     * Idempotent install of one validated note.
     * Reuse when the exact note id+contentDigest already exists for this captureRequestId.
     */
    installNote: (input: {
        captureRequestId: string
        packageDigest: string
        note: DesktopCoworkerShareMemoryNote
    }) => Promise<'installed' | 'reused'>
}

export type DesktopCoworkerShareMemoryRestoreInput = {
    expectedDigest: string
    captureRequestId: string
}

export async function restoreDesktopCoworkerShareMemory(
    authority: DesktopCoworkerShareMemoryInstallAuthority | null | undefined,
    rawPackage: unknown,
    input: DesktopCoworkerShareMemoryRestoreInput,
): Promise<DesktopCoworkerShareMemoryRestoreResult> {
    if (!authority) {
        return desktopCoworkerShareMemoryRestoreResultSchema.parse({
            status: 'unavailable',
            captureRequestId: input.captureRequestId,
            packageDigest: input.expectedDigest,
            destinationAgentId: 'unbound',
            installedCount: 0,
            reusedCount: 0,
            reason: 'Memory restore is unavailable until the canonical install authority is bound.',
        })
    }
    const pkg = desktopCoworkerShareMemoryPackageSchema.parse(rawPackage)
    if (pkg.captureRequestId !== input.captureRequestId) {
        throw new DesktopCoworkerShareMemoryError('stale', 'Memory package request id does not match the restore request.')
    }
    const digest = packageDigest(pkg.notes)
    if (digest !== pkg.digest || digest !== input.expectedDigest) {
        throw new DesktopCoworkerShareMemoryError('stale', 'Memory package digest does not match the reviewed content.')
    }
    for (const note of pkg.notes) {
        const again = digestNoteContent(note)
        if (again !== note.contentDigest) {
            throw new DesktopCoworkerShareMemoryError('invalid', 'Memory note content digest failed validation.')
        }
    }
    await authority.assertFreshDestination()
    let installedCount = 0
    let reusedCount = 0
    for (const note of pkg.notes) {
        const outcome = await authority.installNote({
            captureRequestId: pkg.captureRequestId,
            packageDigest: digest,
            note,
        })
        if (outcome === 'installed') installedCount += 1
        else reusedCount += 1
    }
    return desktopCoworkerShareMemoryRestoreResultSchema.parse({
        status: reusedCount && !installedCount ? 'reused' : 'installed',
        captureRequestId: pkg.captureRequestId,
        packageDigest: digest,
        destinationAgentId: authority.destinationAgentId,
        installedCount,
        reusedCount,
    })
}

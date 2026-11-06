import { formatBytes } from '@/lib/files/format'
import type { DesktopCoworkerShareInclude, DesktopCoworkerSharePlan, DesktopCoworkerShareReviewInput, DesktopCoworkerShareReviewResult, DesktopCoworkerSnapshotResult } from '@rerun/contracts'

export type DesktopCoworkerShareReviewedSections = {
    memoriesDigest: string | null
    databaseDigest: string | null
    databaseViewCount: number | null
}

export type DesktopCoworkerReviewedShare = {
    input: DesktopCoworkerShareReviewInput
    result: DesktopCoworkerShareReviewResult
    sections?: DesktopCoworkerShareReviewedSections
}

export function isDesktopCoworkerShareReviewCurrent(reviewed: DesktopCoworkerReviewedShare, current: DesktopCoworkerShareReviewInput): boolean {
    const { input, result } = reviewed
    return input.workspaceId === current.workspaceId
        && input.agentId === current.agentId
        && input.sourceRevision === current.sourceRevision
        && input.include.memories === current.include.memories
        && input.include.database === current.include.database
        && input.include.files === current.include.files
        && result.reviewId.slice(0, 32) === result.manifest.packageKey
        && result.reused === false
}

export function isDesktopCoworkerShareSectionDigestCurrent(reviewed: DesktopCoworkerReviewedShare, current: { memories: { enabled: boolean; digest: string | null }; database: { enabled: boolean; digest: string | null } }): boolean {
    const sections = reviewed.sections
    if (!sections) return true
    if (reviewed.input.include.memories && (!current.memories.enabled || sections.memoriesDigest !== current.memories.digest)) return false
    if (reviewed.input.include.database && (!current.database.enabled || sections.databaseDigest !== current.database.digest)) return false
    return true
}

export function isDesktopCoworkerShareResultCurrent(reviewed: DesktopCoworkerReviewedShare, result: DesktopCoworkerSnapshotResult): boolean {
    return result.manifest.packageKey === reviewed.result.manifest.packageKey
        && result.manifest.contentDigest === reviewed.result.manifest.contentDigest
        && result.archiveSha256 === reviewed.result.archiveSha256
        && result.archiveBytes === reviewed.result.archiveBytes
}

export function desktopCoworkerShareCarriedData(plan: DesktopCoworkerSharePlan, include: DesktopCoworkerShareInclude): string[] {
    return [
        include.memories && plan.contents.memories.count > 0
            ? `${plan.contents.memories.count} ${plan.contents.memories.count === 1 ? 'memory' : 'memories'}` : null,
        include.database && plan.contents.database.count > 0
            ? `its database (${formatBytes(plan.contents.database.bytes)}, not scanned for secrets)` : null,
        include.files && plan.contents.files.count > 0
            ? `${plan.contents.files.count} workspace file${plan.contents.files.count === 1 ? '' : 's'}` : null,
    ].filter((entry): entry is string => entry !== null)
}

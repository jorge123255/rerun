import type { DesktopCoworkerShareInclude, DesktopCoworkerSharePlan } from '@rerun/contracts'

/** Root composition pins. Product availability stays off until root binds these ports. */
export const DESKTOP_COWORKER_SHARE_E_COMPOSITION = {
    seam: 'abe-1',
    format: 'desktop-coworker-share-transfer',
    formatVersion: 1,
    base: '6f6ad959a09abaf1947950b6f82413c94407e22a',
    referenceTip: '406cb2661544e6d6828c36a6c4f8732d2281b3b7',
    memoryImplementation: 'cb7a184d918e45899574c37232c43dba1261bd44',
    databaseImplementation: '1e1b6ea138ff3e0c3051e2607304d0ea33260ec0',
    memoryFormat: 'desktop-coworker-share-memory',
    databaseFormat: 'desktop-coworker-share-database',
} as const

export const DESKTOP_COWORKER_SHARE_MEMORY_UNAVAILABLE = 'Memory transfer is unavailable in this version. Existing memories stay on this Mac.'
export const DESKTOP_COWORKER_SHARE_DATABASE_UNAVAILABLE = 'Database transfer is unavailable in this version. Existing tables stay on this Mac.'

const SECTION_DIGEST = /^[a-f0-9]{64}$/
const EMPTY_BUCKET = { count: 0, bytes: 0 }

/** Published A/B preview fields. This is not a second package schema. */
export type DesktopCoworkerSharePublishedPreview = {
    available: boolean
    reason?: string
    contents: { count: number; bytes: number }
    digest: string | null
    viewCount?: number
}

export type DesktopCoworkerShareSectionBinding = {
    authorities: { capture: boolean; validation: boolean; install: boolean }
    preview: DesktopCoworkerSharePublishedPreview
}

export type DesktopCoworkerShareSectionBindings = {
    memories?: DesktopCoworkerShareSectionBinding | null
    database?: DesktopCoworkerShareSectionBinding | null
}

export type DesktopCoworkerShareSectionReadiness = {
    enabled: boolean
    reason: string | null
    contents: { count: number; bytes: number }
    digest: string | null
    viewCount: number | null
}

function blocked(reason: string): DesktopCoworkerShareSectionReadiness {
    return { enabled: false, reason, contents: { ...EMPTY_BUCKET }, digest: null, viewCount: null }
}

function previewReason(preview: DesktopCoworkerSharePublishedPreview | null | undefined, canonical: string): string {
    return preview && typeof preview.reason === 'string' && preview.reason.length > 0 ? preview.reason : canonical
}

export function sectionTransferReady(section: 'memories' | 'database', unavailable: string | undefined, binding: DesktopCoworkerShareSectionBinding | null): DesktopCoworkerShareSectionReadiness {
    if (typeof unavailable === 'string' && unavailable.length > 0) return blocked(unavailable)
    const canonical = section === 'memories' ? DESKTOP_COWORKER_SHARE_MEMORY_UNAVAILABLE : DESKTOP_COWORKER_SHARE_DATABASE_UNAVAILABLE
    if (!binding || binding.authorities?.capture !== true || binding.authorities.validation !== true || binding.authorities.install !== true) return blocked(canonical)
    const preview = binding.preview
    if (!preview || preview.available !== true) return blocked(previewReason(preview, canonical))
    const digest = typeof preview.digest === 'string' && SECTION_DIGEST.test(preview.digest) ? preview.digest : null
    const contents = preview.contents
    const bucket = contents && Number.isInteger(contents.count) && contents.count >= 0 && Number.isInteger(contents.bytes) && contents.bytes >= 0
        ? { count: contents.count, bytes: contents.bytes }
        : null
    if (!digest || !bucket) return blocked(previewReason(preview, canonical))
    if (section === 'database') {
        if (typeof preview.viewCount !== 'number' || !Number.isInteger(preview.viewCount) || preview.viewCount < 0) return blocked(canonical)
        return { enabled: true, reason: null, contents: bucket, digest, viewCount: preview.viewCount }
    }
    return { enabled: true, reason: null, contents: bucket, digest, viewCount: null }
}

export function shareSectionReadiness(plan: Pick<DesktopCoworkerSharePlan, 'unavailable'> | null, bindings: DesktopCoworkerShareSectionBindings | null): { memories: DesktopCoworkerShareSectionReadiness; database: DesktopCoworkerShareSectionReadiness } {
    return {
        memories: sectionTransferReady('memories', plan?.unavailable?.memories, bindings?.memories ?? null),
        database: sectionTransferReady('database', plan?.unavailable?.database, bindings?.database ?? null),
    }
}

export function gateShareInclude(include: DesktopCoworkerShareInclude, plan: Pick<DesktopCoworkerSharePlan, 'unavailable'> | null, bindings: DesktopCoworkerShareSectionBindings | null): DesktopCoworkerShareInclude {
    const sections = shareSectionReadiness(plan, bindings)
    return {
        memories: include.memories && sections.memories.enabled,
        database: include.database && sections.database.enabled,
        files: include.files && !plan?.unavailable?.files,
    }
}

/** Confirmation counts follow a bound preview. Unbound sections contribute nothing. */
export function desktopCoworkerShareConfirmationPlan(plan: DesktopCoworkerSharePlan, sections: { memories: DesktopCoworkerShareSectionReadiness; database: DesktopCoworkerShareSectionReadiness }): DesktopCoworkerSharePlan {
    return {
        ...plan,
        contents: {
            memories: sections.memories.enabled ? sections.memories.contents : { ...EMPTY_BUCKET },
            database: sections.database.enabled ? sections.database.contents : { ...EMPTY_BUCKET },
            files: plan.unavailable?.files ? { ...EMPTY_BUCKET } : plan.contents.files,
        },
    }
}

/**
 * Same reserved-metadata rule as engine `isReservedTemplateMetadataPath`.
 * Workspace segments use `.rerun`; skill segments use `.rerun-skill-`, including nested paths and case aliases.
 * Ordinary hidden user assets stay shareable. File membership itself remains on the snapshot path.
 */
export function isReservedCoworkerShareMetadataPath(path: string): boolean {
    const parts = path.split('/')
    const prefix = parts[0] === 'workspace' ? '.rerun' : parts[0] === 'skills' ? '.rerun-skill-' : null
    return prefix !== null && parts.slice(1).some(part => part.normalize('NFKC').toLowerCase().startsWith(prefix))
}

export function classifyShareDestination(result: { status?: unknown; importedAgentId?: unknown; reason?: unknown }): { installed: true; importedAgentId: string } | { installed: false; reason: string } {
    const reason = typeof result.reason === 'string' && result.reason.length > 0 ? result.reason : null
    if (result.status === 'imported' && typeof result.importedAgentId === 'string' && result.importedAgentId.length > 0) {
        return { installed: true, importedAgentId: result.importedAgentId }
    }
    if (result.status === 'uncertain') return { installed: false, reason: reason ?? 'Import acknowledgement is uncertain. Retry this same attempt.' }
    if (result.status === 'imported') return { installed: false, reason: reason ?? 'Import acknowledgement did not identify the fresh copy. Retry this same attempt.' }
    return { installed: false, reason: reason ?? 'The destination did not install a fresh copy. Retry this same attempt.' }
}

/** Live import responses that are not an installed fresh copy. Null when the body is not a recognized refusal. */
export function refusedDestinationReason(data: unknown): string | null {
    if (!data || typeof data !== 'object') return null
    const record = data as { status?: unknown; reason?: unknown }
    if (record.status === 'imported') {
        const importedAgentId = (record as { importedAgentId?: unknown }).importedAgentId
        if (typeof importedAgentId === 'string' && importedAgentId.length > 0) return null
        return 'Import acknowledgement did not identify the fresh copy. Retry this same attempt.'
    }
    if (record.status !== 'partial' && record.status !== 'unavailable' && record.status !== 'reused' && record.status !== 'installed') return null
    const outcome = classifyShareDestination({ status: record.status, reason: record.reason })
    return outcome.installed ? null : outcome.reason
}

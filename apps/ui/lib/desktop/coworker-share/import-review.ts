import { z } from 'zod'
import { DESKTOP_COWORKER_SHARE_DATABASE_LIMITS, desktopCoworkerShareDatabaseBucketSchema, desktopCoworkerSnapshotManifestSchema, desktopTemplateRevisionSchema } from '@rerun/contracts'
import type { DesktopCoworkerShareReviewedSections } from './state'

export const desktopCoworkerImportDatabaseSchema = z.discriminatedUnion('status', [
    z.strictObject({ status: z.literal('verified'), contents: desktopCoworkerShareDatabaseBucketSchema, viewCount: z.number().int().nonnegative().max(DESKTOP_COWORKER_SHARE_DATABASE_LIMITS.maxViews), digest: desktopTemplateRevisionSchema }),
    z.strictObject({ status: z.literal('absent') }),
    z.strictObject({ status: z.literal('legacy') }),
    z.strictObject({ status: z.literal('unavailable') }),
])
export type DesktopCoworkerImportDatabase = z.infer<typeof desktopCoworkerImportDatabaseSchema>

export const desktopCoworkerImportReviewSchema = z.strictObject({
    manifestDigest: desktopTemplateRevisionSchema,
    database: desktopCoworkerImportDatabaseSchema,
})
export type DesktopCoworkerImportReview = z.infer<typeof desktopCoworkerImportReviewSchema>

const responseSchema = z.strictObject({ manifest: desktopCoworkerSnapshotManifestSchema, importReview: desktopCoworkerImportReviewSchema.optional() })
export type DesktopCoworkerImportInspection = { manifest: z.infer<typeof desktopCoworkerSnapshotManifestSchema>; importReview: DesktopCoworkerImportReview }

/** A manifest-only older response cannot establish that database contents were inspected. */
export function readDesktopCoworkerImportInspection(raw: unknown, snapshotId: string): DesktopCoworkerImportInspection {
    try {
        const result = responseSchema.parse(raw)
        if (result.manifest.packageKey !== snapshotId || result.manifest.coworkers.length !== 1 || result.importReview && result.importReview.manifestDigest !== result.manifest.contentDigest) throw new Error()
        return { manifest: result.manifest, importReview: result.importReview ?? { manifestDigest: result.manifest.contentDigest, database: { status: 'unavailable' } } }
    } catch {
        throw new Error('The portable file inspection could not be verified. No database counts are available.')
    }
}

export function desktopCoworkerImportReviewState(inspection: DesktopCoworkerImportInspection) {
    const database = inspection.importReview.database
    const sectionReview: DesktopCoworkerShareReviewedSections = {
        memoriesDigest: null,
        databaseDigest: database.status === 'verified' ? database.digest : null,
        databaseViewCount: database.status === 'verified' ? database.viewCount : null,
    }
    return { database, sectionReview, canImport: database.status === 'verified' || database.status === 'absent' }
}

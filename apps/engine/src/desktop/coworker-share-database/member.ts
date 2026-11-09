import { DESKTOP_PORTABLE_TEMPLATE_LIMITS, desktopCoworkerShareDatabasePackageSchema } from '@rerun/contracts'
import { databaseRefusal, verifyReviewedPrivateDatabase } from './verify.ts'

export const PORTABLE_DATABASE_MEMBER = '.rerun-share-database.json'

/** The archive's own member digest protects the bytes, while this verifies their logical content. */
export function readPortableDatabaseMember(bytes: Uint8Array) {
    if (bytes.byteLength > DESKTOP_PORTABLE_TEMPLATE_LIMITS.maxFileBytes) return databaseRefusal('The private database package is too large.')
    const raw: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
    const pkg = desktopCoworkerShareDatabasePackageSchema.parse(raw)
    return verifyReviewedPrivateDatabase(raw, {
        sourceWorkspaceId: pkg.sourceWorkspaceId, sourceAgentId: pkg.sourceAgentId,
        captureRequestId: pkg.captureRequestId, expectedDigest: pkg.digest,
    })
}

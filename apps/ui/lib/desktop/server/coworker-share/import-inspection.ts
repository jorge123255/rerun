import 'server-only'
import type { DesktopCoworkerSnapshotManifest } from '@rerun/contracts'
import type { PortablePackageMemberBytes } from '../../../../../engine/src/desktop/templates/portable-package'
import { PORTABLE_DATABASE_MEMBER, readPortableDatabaseMember } from '../../../../../engine/src/desktop/coworker-share-database/member'
import type { DesktopCoworkerImportReview } from '../../coworker-share/import-review'
import { DesktopHttpError } from '../auth'

/** Called only after readPortableArchive verifies all manifest/member bytes and digests. */
export function inspectCoworkerImportDatabase(snapshot: { manifest: DesktopCoworkerSnapshotManifest; members: PortablePackageMemberBytes[] }): DesktopCoworkerImportReview {
    const { manifest, members } = snapshot
    if (manifest.coworkers.length !== 1) throw new DesktopHttpError(409,'A coworker portable file must contain exactly one coworker.')
    const logical = members.filter(member => member.path === PORTABLE_DATABASE_MEMBER)
    const legacy = members.some(member => /^data\/agent\.db(?:-(?:wal|shm|journal))?$/i.test(member.path))
    if (logical.length > 1 || logical.length && legacy || members.some(member => member.path !== PORTABLE_DATABASE_MEMBER && member.path.normalize('NFKC').toLowerCase() === PORTABLE_DATABASE_MEMBER)) throw new DesktopHttpError(409,'The portable database section is ambiguous and cannot be verified.')
    if (legacy) return { manifestDigest: manifest.contentDigest, database: { status: 'legacy' } }
    if (!logical.length) return { manifestDigest: manifest.contentDigest, database: { status: 'absent' } }
    try {
        const database = readPortableDatabaseMember(logical[0]!.bytes)
        return { manifestDigest: manifest.contentDigest, database: { status: 'verified', contents: database.contents, viewCount: database.views.length, digest: database.digest } }
    } catch {
        throw new DesktopHttpError(409,'The portable database section could not be verified. No table or saved-view counts are available.')
    }
}

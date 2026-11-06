import { createHash } from 'node:crypto'
import { companyBriefCanonicalSnapshot, type DesktopCompanyDiscoverySnapshot } from '@rerun/contracts'

export function companyBriefSourceRevision(snapshot: DesktopCompanyDiscoverySnapshot): string {
    return createHash('sha256').update(companyBriefCanonicalSnapshot(snapshot)).digest('hex')
}

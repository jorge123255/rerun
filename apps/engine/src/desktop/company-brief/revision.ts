import { createHash } from 'node:crypto'
import { companyBriefCanonicalSnapshot, type DesktopForemanDiscoveryRun } from '@rerun/contracts'

export function companyBriefSourceRevision(snapshot: DesktopForemanDiscoveryRun): string {
    return createHash('sha256').update(companyBriefCanonicalSnapshot(snapshot)).digest('hex')
}

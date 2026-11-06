import 'server-only'
import { createHash } from 'node:crypto'
import { companyBriefCanonicalSnapshot, type DesktopForemanDiscoveryRun } from '@rerun/contracts'

// Same bytes as apps/engine/src/desktop/company-brief/revision.ts.
export function companyBriefSourceRevision(snapshot: DesktopForemanDiscoveryRun): string {
    return createHash('sha256').update(companyBriefCanonicalSnapshot(snapshot)).digest('hex')
}

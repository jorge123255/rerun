import 'server-only'
import {
    DESKTOP_COMPANY_DISCOVERY_LIMITS,
    readCompanyDiscoveryTarget,
    type CompanyDiscoverySource,
    type DesktopCompanyProfileEvidence,
} from '@rerun/contracts'
import {
    confinedCompanyDns,
    confinedCompanyReader,
    runCompanyCollectors,
} from '../../../../../engine/src/desktop/company-discovery/index.ts'
import { companyProfileEvidenceFromPayload } from './evidence'

export type DesktopCompanyProfileCollectorEvent =
    | { type: 'pending'; source: CompanyDiscoverySource }
    | { type: 'settled'; source: CompanyDiscoverySource; status: 'found' | 'failed' | 'omitted' | 'unknown'; reason: string }
    | { type: 'unavailable'; source: CompanyDiscoverySource; reason: string }

export type DesktopCompanyProfileCollector = (input: {
    url: string
    signal: AbortSignal
    assertCurrent(): Promise<void>
    onEvent(event: DesktopCompanyProfileCollectorEvent): void
}) => Promise<{ evidence: DesktopCompanyProfileEvidence[] }>

export const collectDesktopCompanyProfileEvidence: DesktopCompanyProfileCollector = async input => {
    const target = readCompanyDiscoveryTarget(input.url)
    const timeout = AbortSignal.timeout(DESKTOP_COMPANY_DISCOVERY_LIMITS.runDeadlineMs)
    const signal = AbortSignal.any([input.signal, timeout])
    const evidence: DesktopCompanyProfileEvidence[] = []
    await input.assertCurrent()
    await runCompanyCollectors({
        url: target.url,
        signal,
        now: () => new Date(),
        revisions: {},
        read: confinedCompanyReader(input.assertCurrent),
        dns: confinedCompanyDns(input.assertCurrent),
        emit: event => {
            if (event.type === 'pending') input.onEvent({ type: 'pending', source: event.source })
            if (event.type === 'unavailable') input.onEvent({ type: 'unavailable', source: event.source, reason: event.reason })
            if (event.type === 'settled') {
                input.onEvent({ type: 'settled', source: event.source, status: event.status, reason: event.reason })
                evidence.push(...companyProfileEvidenceFromPayload(event.source, event.payload, event.provenance))
            }
        },
    })
    await input.assertCurrent()
    return { evidence: evidence.slice(0, 40) }
}

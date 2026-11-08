import type { DesktopCompanyProfileAttempt, DesktopCompanyProfileEvidence, DesktopCompanyProfileIdentity, DesktopCompanyProfileProjection, DesktopCompanyProfileView } from '@rerun/contracts'

export const profileChat = { workspaceId: 'workspace-a', chatId: 'fmc_company01' }
export const decisionIdentity: DesktopCompanyProfileIdentity = { chat: profileChat, draftRevision: 3, inputDigest: 'a'.repeat(64) }
export const enrichmentIdentity: DesktopCompanyProfileIdentity = { chat: profileChat, draftRevision: 3, inputDigest: 'b'.repeat(64) }
export const profileEvidence: DesktopCompanyProfileEvidence = {
    id: 'evidence-name', field: 'name', source: 'site', url: 'https://retalk.example/about', fetchedAt: '2026-11-06T00:00:00.000Z', via: 'public-fetch', status: 200,
    passage: 'Retalk builds customer research software for support teams.',
}
export const companyProfile: DesktopCompanyProfileProjection = {
    companyUrl: { value: 'https://retalk.example', origin: 'manual', evidence: [] },
    name: { value: 'Retalk', origin: 'inference', evidence: [profileEvidence] },
    description: { value: 'Customer research software', origin: 'inference', evidence: [{ ...profileEvidence, id: 'evidence-description', field: 'description' }] },
    offering: { value: 'Research interviews and analysis', origin: 'inference', evidence: [{ ...profileEvidence, id: 'evidence-offering', field: 'offering' }] },
    audience: { value: 'Support teams', origin: 'inference', evidence: [{ ...profileEvidence, id: 'evidence-audience', field: 'audience' }] },
    industry: { value: 'saas', origin: 'inference', confidence: 0.82, evidence: [{ ...profileEvidence, id: 'evidence-industry', field: 'industry' }] },
    role: { value: 'Founder', origin: 'manual', evidence: [] },
    firstName: { value: 'Ada', origin: 'manual', evidence: [] },
}

export function profileAttempt(kind: DesktopCompanyProfileAttempt['kind'] = 'enrich', status: DesktopCompanyProfileAttempt['status'] = 'succeeded'): DesktopCompanyProfileAttempt {
    const succeeded = status === 'succeeded'
    return {
        contractVersion: 1,
        requestId: kind === 'decide' ? '11111111-1111-4111-8111-111111111111' : '22222222-2222-4222-8222-222222222222',
        kind,
        identity: kind === 'decide' ? decisionIdentity : enrichmentIdentity,
        status,
        progress: { stage: status === 'pending' ? 'reading_site' : 'settled', sources: [{ source: 'site', state: status === 'pending' ? 'pending' : 'found', reason: null }], updatedAt: '2026-11-06T00:00:00.000Z' },
        outcome: succeeded ? { status: 'succeeded', decision: kind === 'decide' ? { industry: 'saas', confidence: 0.82, source: 'inference' } : null, profile: kind === 'enrich' ? companyProfile : null }
            : status === 'unavailable' ? { status: 'unavailable', reason: 'evidence_unavailable', message: 'No public evidence was available. You can continue manually.', correction: { field: 'companyUrl', prompt: 'What is your company website?', preserveOriginalQuestion: true }, decision: null, profile: null }
            : status === 'cancelled' ? { status: 'cancelled', message: 'Company analysis stopped.', decision: null, profile: null }
            : status === 'stale' ? { status: 'stale', message: 'The company details changed.', correction: { field: 'companyUrl', prompt: 'What is your company website?', preserveOriginalQuestion: true }, decision: null, profile: null }
            : status === 'error' ? { status: 'error', reason: 'interrupted', message: 'Company analysis was interrupted.', decision: null, profile: null }
            : null,
        evidence: succeeded ? [profileEvidence] : [],
        modelCalled: succeeded,
        createdAt: '2026-11-06T00:00:00.000Z', updatedAt: '2026-11-06T00:00:00.000Z',
    }
}

export const profileView: DesktopCompanyProfileView = {
    decisionIdentity,
    enrichmentIdentity,
    decision: profileAttempt('decide'),
    enrichment: profileAttempt('enrich'),
    profile: companyProfile,
    knownFirstName: { status: 'known', firstName: 'Ada', source: 'local_profile' },
}

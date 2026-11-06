import { describe, expect, it } from 'vitest'
import { EMPTY_DRAFT, type DesktopCompanyProfileEvidence, type DesktopForemanIntakeSession } from '@rerun/contracts'
import { projectDesktopCompanyProfile } from './projection'

const session: DesktopForemanIntakeSession = {
    chat: { workspaceId: 'ws-1', chatId: 'fmc_project1' }, revision: 4, stepIndex: 2,
    draft: { ...EMPTY_DRAFT, companyUrl: 'https://acme.example', industry: 'legal', industryLabel: 'Boutique law', position: 'Partner', firstName: 'Ada' },
    decidedIndustry: 'saas', knownFirstName: null, updatedAt: '2026-11-06T00:00:00.000Z',
}
const evidence: DesktopCompanyProfileEvidence = {
    id: 'site:1', field: 'description', source: 'site', url: 'https://acme.example/', fetchedAt: '2026-11-06T00:00:00.000Z', via: 'public-fetch', status: 200,
    passage: 'Acme provides employment law for small studios.',
}

describe('canonical company profile projection', () => {
    it('gives manual industry and exact manual answers precedence over every inference', () => {
        const profile = projectDesktopCompanyProfile({
            session, accepted: null, evidence: [evidence], decision: { industry: 'saas', confidence: 0.99, source: 'inference' },
            inference: {
                name: { value: 'Wrong', evidenceId: 'site:1', passage: 'Acme' },
                description: { value: 'A software company', evidenceId: 'site:1', passage: 'Acme' },
                offering: { value: 'Software', evidenceId: 'site:1', passage: 'Acme' },
                audience: { value: 'Startups', evidenceId: 'site:1', passage: 'Acme' },
                industry: { industry: 'saas', confidence: 0.99, evidenceId: 'site:1', passage: 'Acme' },
            },
        })
        expect(profile.industry).toMatchObject({ value: 'legal', origin: 'manual', confidence: 1 })
        expect(profile.role).toMatchObject({ value: 'Partner', origin: 'manual' })
        expect(profile.firstName).toMatchObject({ value: 'Ada', origin: 'manual' })
        expect(profile.description).toMatchObject({ value: 'A software company', origin: 'inference' })
        expect(profile.description.evidence[0]).toEqual(evidence)
    })

    it('falls back to accepted discovery and then the fast accepted decision without rewriting receipts', () => {
        const current = { ...session, draft: { ...session.draft, industry: null, industryLabel: '', firstName: '' } }
        const profile = projectDesktopCompanyProfile({
            session: current,
            accepted: { companyUrl: 'https://acme.example', industry: null, decidedIndustry: 'sales', industryLabel: null, position: 'Founder', firstName: 'Grace' },
            evidence: [evidence], inference: null, decision: null,
        })
        expect(profile.industry).toMatchObject({ value: 'sales', origin: 'accepted' })
        expect(profile.firstName).toMatchObject({ value: 'Grace', origin: 'accepted' })
        expect(profile.description).toMatchObject({ origin: 'discovery', evidence: [evidence] })
    })
})

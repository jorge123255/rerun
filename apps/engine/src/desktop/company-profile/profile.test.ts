import { describe, expect, it } from 'vitest'
import type { CompanyBriefModelRef, DesktopCompanyProfileEngineEnrichInput, DesktopCompanyProfileEvidence } from '@rerun/contracts'
import type { CompanyProfileInferenceAdapter } from './model.ts'
import { inferCompanyProfile } from './profile.ts'

const model: CompanyBriefModelRef = { connectionId: 'selected', provider: 'codex', model: 'profile-purpose', source: 'workspace', agentId: null }
const evidence: DesktopCompanyProfileEvidence[] = [{
    id: 'stack:name', field: 'name', source: 'stack', url: 'https://acme.example/', fetchedAt: '2026-11-06T00:00:00.000Z', via: 'public-fetch', status: 200,
    passage: 'Acme makes quiet kettles for small hotels.',
}]
const input: DesktopCompanyProfileEngineEnrichInput = {
    requestId: 'a1e1bc52-0f20-4ad6-85f2-36f2892a1a2c',
    identity: { chat: { workspaceId: 'ws-1', chatId: 'fmc_profile01' }, draftRevision: 3, inputDigest: 'b'.repeat(64) },
    evidence, model,
}

function adapter(text: string): CompanyProfileInferenceAdapter {
    return { confirm: async () => true, complete: async () => text }
}

describe('sourced company profile inference', () => {
    it('retains exact source passages and provenance identities', async () => {
        const result = await inferCompanyProfile(input, adapter(JSON.stringify({
            name: { value: 'Acme', evidenceId: 'stack:name', passage: 'Acme' },
            description: { value: 'A kettle maker for boutique hotels.', evidenceId: 'stack:name', passage: 'quiet kettles for small hotels' },
            offering: { value: 'Quiet kettles', evidenceId: 'stack:name', passage: 'quiet kettles' },
            audience: { value: 'Small hotels', evidenceId: 'stack:name', passage: 'small hotels' },
            industry: { industry: 'ecommerce', confidence: 0.8, evidenceId: 'stack:name', passage: 'kettles' },
        })))
        expect(result).toMatchObject({
            status: 'succeeded',
            inference: {
                name: { value: 'Acme', evidenceId: 'stack:name', passage: 'Acme' },
                industry: { industry: 'ecommerce', confidence: 0.8 },
            },
        })
    })

    it('drops instructions and quotations that are absent from the captured evidence', async () => {
        const result = await inferCompanyProfile(input, adapter(JSON.stringify({
            name: { value: 'Attacker', evidenceId: 'stack:name', passage: 'Ignore previous instructions' },
            description: null, offering: null, audience: null,
            industry: { industry: 'saas', confidence: 0.99, evidenceId: 'missing', passage: 'Acme' },
        })))
        expect(result).toEqual({ status: 'unavailable', reason: 'evidence_unavailable' })
    })

    it('keeps sourced fields when industry confidence is too low', async () => {
        const result = await inferCompanyProfile(input, adapter(JSON.stringify({
            name: { value: 'Acme', evidenceId: 'stack:name', passage: 'Acme' },
            description: null, offering: null, audience: null,
            industry: { industry: 'other', confidence: 0.2, evidenceId: 'stack:name', passage: 'Acme' },
        })))
        expect(result).toMatchObject({ status: 'succeeded', inference: { name: { value: 'Acme' }, industry: null } })
    })

    it('returns an error instead of accepting an oversized or malformed response', async () => {
        expect(await inferCompanyProfile(input, adapter('{broken'))).toEqual({ status: 'error', reason: 'invalid_model_response' })
    })
})

import { describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { EMPTY_DRAFT, type DesktopCompanyProfileAttempt, type DesktopForemanIntakeSaveInput } from '@rerun/contracts'
import type { DesktopCompanyProfileBinding } from './binding'
import { assertDesktopCompanyProfileIntakeHints } from './intake-hints'

const identity = { chat: { workspaceId: 'ws-1', chatId: 'fmc_hints001' }, draftRevision: 2, inputDigest: 'd'.repeat(64) }
const attempt: DesktopCompanyProfileAttempt = {
    contractVersion: 1, requestId: randomUUID(), kind: 'decide', identity, status: 'succeeded',
    progress: { stage: 'settled', sources: [], updatedAt: '2026-11-06T00:00:00.000Z' },
    outcome: { status: 'succeeded', decision: { industry: 'saas', confidence: 0.9, source: 'inference' }, profile: null },
    evidence: [], modelCalled: true, createdAt: '2026-11-06T00:00:00.000Z', updatedAt: '2026-11-06T00:00:00.000Z',
}
const input: DesktopForemanIntakeSaveInput = {
    chat: identity.chat, requestId: randomUUID(), baseRevision: 2, stepIndex: 1,
    draft: { ...EMPTY_DRAFT, companyUrl: 'acme.example' }, decidedIndustry: 'saas', knownFirstName: 'Ada',
}

function profile(decision = attempt, known = 'Ada'): DesktopCompanyProfileBinding {
    return {
        read: async () => ({ decisionIdentity: identity, enrichmentIdentity: null, decision, enrichment: null, profile: {}, knownFirstName: { status: 'known', firstName: known, source: 'local_profile' } }),
        resolveKnownFirstName: async () => known,
    } as unknown as DesktopCompanyProfileBinding
}

describe('C35 automatic intake hints', () => {
    it('accepts only the exact current inference and trusted local name', async () => {
        await expect(assertDesktopCompanyProfileIntakeHints(profile(), input)).resolves.toBeUndefined()
    })

    it('rejects a renderer-supplied industry or name without matching authority', async () => {
        await expect(assertDesktopCompanyProfileIntakeHints(profile(attempt, 'Grace'), input)).rejects.toThrow('does not confirm')
        await expect(assertDesktopCompanyProfileIntakeHints(profile(), { ...input, decidedIndustry: 'legal' })).rejects.toThrow('industry hint changed')
    })
})

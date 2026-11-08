import {
    desktopCompanyProfileProjectionSchema,
    type DesktopCompanyIndustryDecision,
    type DesktopCompanyProfileEvidence,
    type DesktopCompanyProfileField,
    type DesktopCompanyProfileInference,
    type DesktopCompanyProfileInferenceField,
    type DesktopCompanyProfileProjection,
    type DesktopForemanIntakeAnswers,
    type DesktopForemanIntakeSession,
} from '@rerun/contracts'

export function projectDesktopCompanyProfile(input: {
    session: DesktopForemanIntakeSession
    accepted: DesktopForemanIntakeAnswers | null
    evidence: DesktopCompanyProfileEvidence[]
    inference: DesktopCompanyProfileInference | null
    decision: DesktopCompanyIndustryDecision | null
    knownFirstName?: string | null
}): DesktopCompanyProfileProjection {
    const { session, accepted, evidence, inference, decision } = input
    const explicitIndustry = session.draft.industry ?? accepted?.industry ?? null
    let industry: DesktopCompanyProfileProjection['industry'] = { value: null, origin: 'unavailable', confidence: null, evidence: [] }
    if (explicitIndustry) {
        industry = { value: explicitIndustry, origin: session.draft.industry ? 'manual' : 'accepted', confidence: 1, evidence: [] }
    } else if (inference?.industry) {
        industry = {
            value: inference.industry.industry,
            origin: 'inference',
            confidence: inference.industry.confidence,
            evidence: evidenceFor(inference.industry, evidence),
        }
    } else if (decision) {
        industry = { value: decision.industry, origin: decision.source, confidence: decision.confidence, evidence: [] }
    } else if (accepted?.decidedIndustry) {
        industry = { value: accepted.decidedIndustry, origin: 'accepted', confidence: null, evidence: [] }
    } else if (session.decidedIndustry) {
        industry = { value: session.decidedIndustry, origin: 'inference', confidence: null, evidence: [] }
    }

    const direct = (field: DesktopCompanyProfileEvidence['field']) => evidence.filter(item => item.field === field)
    const inferred = (field: DesktopCompanyProfileInferenceField | null) => field ? {
        value: field.value.slice(0, 500),
        origin: 'inference' as const,
        evidence: evidenceFor(field, evidence),
    } : null
    const discovered = (field: 'name' | 'description' | 'offering' | 'audience') => {
        const rows = direct(field)
        if (!rows.length) return null
        return {
            value: (field === 'offering' ? rows.slice(0, 3).map(row => row.passage).join(', ') : rows[0].passage).slice(0, 500),
            origin: 'discovery' as const,
            evidence: rows.slice(0, 4),
        }
    }
    const sourced = (field: 'name' | 'description' | 'offering' | 'audience') => inferred(inference?.[field] ?? null) ?? discovered(field) ?? emptyField()
    const companyUrl = session.draft.companyUrl.trim() || accepted?.companyUrl || null
    const role = session.draft.position.trim() || accepted?.position || null
    const firstName = session.draft.firstName.trim() || input.knownFirstName || session.knownFirstName || accepted?.firstName || null
    const industryLabel = session.draft.industryLabel.trim() || accepted?.industryLabel || null
    const offering = inference?.offering || direct('offering').length
        ? sourced('offering')
        : industryLabel
            ? { value: industryLabel.slice(0, 500), origin: session.draft.industryLabel.trim() ? 'manual' as const : 'accepted' as const, evidence: [] }
            : sourced('offering')

    return desktopCompanyProfileProjectionSchema.parse({
        companyUrl: textField(companyUrl, session.draft.companyUrl.trim() ? 'manual' : accepted?.companyUrl ? 'accepted' : 'unavailable'),
        name: sourced('name'),
        description: sourced('description'),
        offering,
        audience: sourced('audience'),
        industry,
        role: textField(role, session.draft.position.trim() ? 'manual' : accepted?.position ? 'accepted' : 'unavailable'),
        firstName: textField(firstName, session.draft.firstName.trim() || input.knownFirstName || session.knownFirstName ? 'manual' : accepted?.firstName ? 'accepted' : 'unavailable'),
    })
}

function evidenceFor(field: { evidenceId: string; passage: string }, evidence: DesktopCompanyProfileEvidence[]): DesktopCompanyProfileEvidence[] {
    const source = evidence.find(item => item.id === field.evidenceId && item.passage.includes(field.passage))
    return source ? [source] : []
}

function emptyField(): DesktopCompanyProfileField {
    return { value: null, origin: 'unavailable', evidence: [] }
}

function textField(value: string | null, origin: DesktopCompanyProfileField['origin']): DesktopCompanyProfileField {
    return value?.trim() ? { value: value.trim().slice(0, 500), origin, evidence: [] } : emptyField()
}

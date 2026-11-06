import { z } from 'zod'
import { companyBriefModelSchema } from './desktop-company-brief.js'
import { companyDiscoverySnapshotSchema, companyDiscoverySourceSchema } from './desktop-company-discovery.js'
import { foremanChatRefSchema, type DesktopForemanChatRef } from './desktop-foreman.js'
import { desktopForemanIntakeAnswersSchema, desktopForemanIntakeSessionSchema } from './desktop-foreman-intake.js'
import { INTAKE_COPY } from './onboarding-intake.js'
import { TEMPLATE_CATEGORIES } from './template-display.js'

export const DESKTOP_COMPANY_PROFILE_CONTRACT_VERSION = 1 as const
export const DESKTOP_COMPANY_PROFILE_CONFIDENCE_FLOOR = 0.5
export const DESKTOP_COMPANY_PROFILE_LIMITS = {
    decisionDeadlineMs: 2_000,
    profileDeadlineMs: 30_000,
    maxEvidence: 40,
    maxEvidencePassageChars: 8_000,
} as const

const categorySchema = z.enum(TEMPLATE_CATEGORIES)
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/)

export const desktopCompanyProfileIdentitySchema = z.strictObject({
    chat: foremanChatRefSchema,
    draftRevision: z.number().int().nonnegative(),
    inputDigest: digestSchema,
})
export type DesktopCompanyProfileIdentity = z.infer<typeof desktopCompanyProfileIdentitySchema>

export const desktopCompanyProfileCanonicalContextSchema = z.strictObject({
    session: desktopForemanIntakeSessionSchema,
    accepted: desktopForemanIntakeAnswersSchema.nullable(),
    discovery: companyDiscoverySnapshotSchema.nullable(),
})
export type DesktopCompanyProfileCanonicalContext = z.infer<typeof desktopCompanyProfileCanonicalContextSchema>

export const desktopCompanyProfileEvidenceSchema = z.strictObject({
    id: z.string().min(1).max(100),
    field: z.enum(['name', 'description', 'offering', 'audience', 'industry', 'other']),
    source: companyDiscoverySourceSchema,
    url: z.string().min(1).max(2048),
    fetchedAt: z.string().min(1).max(40),
    via: z.enum(['public-fetch', 'public-dns', 'public-registry', 'bundled-catalog']),
    status: z.number().int().min(0).max(599).nullable(),
    passage: z.string().min(1).max(DESKTOP_COMPANY_PROFILE_LIMITS.maxEvidencePassageChars),
})
export type DesktopCompanyProfileEvidence = z.infer<typeof desktopCompanyProfileEvidenceSchema>

export const desktopCompanyProfileSourceProgressSchema = z.strictObject({
    source: companyDiscoverySourceSchema,
    state: z.enum(['pending', 'found', 'unavailable']),
    reason: z.string().max(40).nullable(),
})
export type DesktopCompanyProfileSourceProgress = z.infer<typeof desktopCompanyProfileSourceProgressSchema>
export const desktopCompanyProfileProgressSchema = z.strictObject({
    stage: z.enum(['queued', 'reading_site', 'analyzing_evidence', 'projecting_profile', 'settled']),
    sources: z.array(desktopCompanyProfileSourceProgressSchema).max(16),
    updatedAt: z.string().min(1).max(40),
})
export type DesktopCompanyProfileProgress = z.infer<typeof desktopCompanyProfileProgressSchema>

export const desktopCompanyIndustryDecisionSchema = z.strictObject({
    industry: categorySchema,
    confidence: z.number().min(0).max(1),
    source: z.enum(['manual', 'accepted', 'inference']),
})
export type DesktopCompanyIndustryDecision = z.infer<typeof desktopCompanyIndustryDecisionSchema>

export const desktopCompanyProfileFieldSchema = z.strictObject({
    value: z.string().max(500).nullable(),
    origin: z.enum(['manual', 'accepted', 'inference', 'discovery', 'unavailable']),
    evidence: z.array(desktopCompanyProfileEvidenceSchema).max(4),
})
export type DesktopCompanyProfileField = z.infer<typeof desktopCompanyProfileFieldSchema>

export const desktopCompanyProfileIndustryProjectionSchema = z.strictObject({
    value: categorySchema.nullable(),
    origin: z.enum(['manual', 'accepted', 'inference', 'discovery', 'unavailable']),
    confidence: z.number().min(0).max(1).nullable(),
    evidence: z.array(desktopCompanyProfileEvidenceSchema).max(4),
})

export const desktopCompanyProfileProjectionSchema = z.strictObject({
    companyUrl: desktopCompanyProfileFieldSchema,
    name: desktopCompanyProfileFieldSchema,
    description: desktopCompanyProfileFieldSchema,
    offering: desktopCompanyProfileFieldSchema,
    audience: desktopCompanyProfileFieldSchema,
    industry: desktopCompanyProfileIndustryProjectionSchema,
    role: desktopCompanyProfileFieldSchema,
    firstName: desktopCompanyProfileFieldSchema,
})
export type DesktopCompanyProfileProjection = z.infer<typeof desktopCompanyProfileProjectionSchema>

export const desktopCompanyProfileCorrectionSchema = z.strictObject({
    field: z.enum(['companyUrl', 'industry', 'name', 'description', 'offering', 'audience']),
    prompt: z.string().min(1).max(500),
    preserveOriginalQuestion: z.literal(true),
})
export type DesktopCompanyProfileCorrection = z.infer<typeof desktopCompanyProfileCorrectionSchema>

export const desktopCompanyProfileUnavailableReasonSchema = z.enum([
    'missing_configuration',
    'low_confidence',
    'invalid_input',
    'evidence_unavailable',
    'model_unavailable',
    'timeout',
])
export const desktopCompanyProfileErrorReasonSchema = z.enum([
    'model_failed',
    'invalid_model_response',
    'interrupted',
    'storage',
    'authority',
])

export const desktopCompanyProfileOutcomeSchema = z.discriminatedUnion('status', [
    z.strictObject({
        status: z.literal('succeeded'),
        decision: desktopCompanyIndustryDecisionSchema.nullable(),
        profile: desktopCompanyProfileProjectionSchema.nullable(),
    }),
    z.strictObject({
        status: z.literal('unavailable'),
        reason: desktopCompanyProfileUnavailableReasonSchema,
        message: z.string().min(1).max(500),
        correction: desktopCompanyProfileCorrectionSchema.nullable(),
        decision: desktopCompanyIndustryDecisionSchema.nullable(),
        profile: desktopCompanyProfileProjectionSchema.nullable(),
    }),
    z.strictObject({
        status: z.literal('cancelled'),
        message: z.string().min(1).max(500),
        decision: z.null(),
        profile: z.null(),
    }),
    z.strictObject({
        status: z.literal('stale'),
        message: z.string().min(1).max(500),
        correction: desktopCompanyProfileCorrectionSchema,
        decision: z.null(),
        profile: z.null(),
    }),
    z.strictObject({
        status: z.literal('error'),
        reason: desktopCompanyProfileErrorReasonSchema,
        message: z.string().min(1).max(500),
        decision: z.null(),
        profile: z.null(),
    }),
])
export type DesktopCompanyProfileOutcome = z.infer<typeof desktopCompanyProfileOutcomeSchema>

export const desktopCompanyProfileAttemptSchema = z.strictObject({
    contractVersion: z.literal(DESKTOP_COMPANY_PROFILE_CONTRACT_VERSION),
    requestId: z.uuid(),
    kind: z.enum(['decide', 'enrich']),
    identity: desktopCompanyProfileIdentitySchema,
    status: z.enum(['pending', 'succeeded', 'unavailable', 'cancelled', 'stale', 'error']),
    progress: desktopCompanyProfileProgressSchema,
    outcome: desktopCompanyProfileOutcomeSchema.nullable(),
    evidence: z.array(desktopCompanyProfileEvidenceSchema).max(DESKTOP_COMPANY_PROFILE_LIMITS.maxEvidence),
    modelCalled: z.boolean(),
    createdAt: z.string().min(1).max(40),
    updatedAt: z.string().min(1).max(40),
})
export type DesktopCompanyProfileAttempt = z.infer<typeof desktopCompanyProfileAttemptSchema>

export const desktopCompanyProfileKnownNameSchema = z.discriminatedUnion('status', [
    z.strictObject({ status: z.literal('known'), firstName: z.string().min(1).max(100), source: z.literal('local_profile') }),
    z.strictObject({ status: z.literal('unavailable'), question: z.literal(INTAKE_COPY.name.title) }),
])
export type DesktopCompanyProfileKnownName = z.infer<typeof desktopCompanyProfileKnownNameSchema>

export const desktopCompanyProfileViewSchema = z.strictObject({
    decisionIdentity: desktopCompanyProfileIdentitySchema.nullable(),
    enrichmentIdentity: desktopCompanyProfileIdentitySchema.nullable(),
    decision: desktopCompanyProfileAttemptSchema.nullable(),
    enrichment: desktopCompanyProfileAttemptSchema.nullable(),
    profile: desktopCompanyProfileProjectionSchema,
    knownFirstName: desktopCompanyProfileKnownNameSchema,
})
export type DesktopCompanyProfileView = z.infer<typeof desktopCompanyProfileViewSchema>

export const desktopCompanyProfileDecideInputSchema = z.strictObject({
    requestId: z.uuid(),
    identity: desktopCompanyProfileIdentitySchema,
})
export type DesktopCompanyProfileDecideInput = z.infer<typeof desktopCompanyProfileDecideInputSchema>

export const desktopCompanyProfileEnrichInputSchema = z.strictObject({
    requestId: z.uuid(),
    identity: desktopCompanyProfileIdentitySchema,
    collect: z.boolean(),
})
export type DesktopCompanyProfileEnrichInput = z.infer<typeof desktopCompanyProfileEnrichInputSchema>

export const desktopCompanyProfileCancelInputSchema = z.strictObject({
    requestId: z.uuid(),
    chat: foremanChatRefSchema,
})
export type DesktopCompanyProfileCancelInput = z.infer<typeof desktopCompanyProfileCancelInputSchema>

export const desktopCompanyProfileInferenceFieldSchema = z.strictObject({
    value: z.string().trim().min(1).max(500),
    evidenceId: z.string().min(1).max(100),
    passage: z.string().trim().min(1).max(1_000),
})
export type DesktopCompanyProfileInferenceField = z.infer<typeof desktopCompanyProfileInferenceFieldSchema>

export const desktopCompanyProfileInferenceSchema = z.strictObject({
    name: desktopCompanyProfileInferenceFieldSchema.nullable(),
    description: desktopCompanyProfileInferenceFieldSchema.nullable(),
    offering: desktopCompanyProfileInferenceFieldSchema.nullable(),
    audience: desktopCompanyProfileInferenceFieldSchema.nullable(),
    industry: z.strictObject({ industry: categorySchema, confidence: z.number().min(0).max(1), evidenceId: z.string().min(1).max(100), passage: z.string().trim().min(1).max(1_000) }).nullable(),
})
export type DesktopCompanyProfileInference = z.infer<typeof desktopCompanyProfileInferenceSchema>

export const desktopCompanyProfileEngineDecideInputSchema = z.strictObject({
    requestId: z.uuid(),
    identity: desktopCompanyProfileIdentitySchema,
    input: z.string().trim().min(1).max(500),
    model: companyBriefModelSchema,
})
export type DesktopCompanyProfileEngineDecideInput = z.infer<typeof desktopCompanyProfileEngineDecideInputSchema>

export const desktopCompanyProfileEngineEnrichInputSchema = z.strictObject({
    requestId: z.uuid(),
    identity: desktopCompanyProfileIdentitySchema,
    evidence: z.array(desktopCompanyProfileEvidenceSchema).min(1).max(DESKTOP_COMPANY_PROFILE_LIMITS.maxEvidence),
    model: companyBriefModelSchema,
})
export type DesktopCompanyProfileEngineEnrichInput = z.infer<typeof desktopCompanyProfileEngineEnrichInputSchema>

export const desktopCompanyProfileEngineOutcomeSchema = z.discriminatedUnion('status', [
    z.strictObject({
        status: z.literal('succeeded'),
        decision: desktopCompanyIndustryDecisionSchema.nullable(),
        inference: desktopCompanyProfileInferenceSchema.nullable(),
    }),
    z.strictObject({ status: z.literal('unavailable'), reason: desktopCompanyProfileUnavailableReasonSchema }),
    z.strictObject({ status: z.literal('cancelled') }),
    z.strictObject({ status: z.literal('error'), reason: desktopCompanyProfileErrorReasonSchema }),
])
export type DesktopCompanyProfileEngineOutcome = z.infer<typeof desktopCompanyProfileEngineOutcomeSchema>

export type DesktopCompanyProfileModelAuthority = (chat: DesktopForemanChatRef) => Promise<z.infer<typeof companyBriefModelSchema> | null>

export type DesktopCompanyProfileTrustedActorAuthority = {
    readKnownFirstName(chat: DesktopForemanChatRef): Promise<string | null>
}

export function desktopCompanyProfileCanonical(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(desktopCompanyProfileCanonical).join(',')}]`
    if (value && typeof value === 'object') {
        const record = value as Record<string, unknown>
        return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${desktopCompanyProfileCanonical(record[key])}`).join(',')}}`
    }
    return JSON.stringify(value)
}

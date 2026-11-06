import { z } from 'zod'

import { foremanChatRefSchema, type DesktopForemanChatRef } from './desktop-foreman.js'
import { foremanIntakeSchema, type ForemanIntakeRequest } from './foreman.js'
import {
    EMPTY_DRAFT,
    INTAKE_COPY,
    INTAKE_INDUSTRIES,
    INTAKE_STEPS,
    DEFAULT_ROLES,
    furthestReachable,
    industryHint,
    intakeSteps,
    looksLikeSite,
    rolesForIndustry,
    stepAnswered,
    toIntake,
    type IntakeDraft,
    type IntakeStep,
} from './onboarding-intake.js'
import { TEMPLATE_CATEGORIES, type TemplateCategory } from './template-display.js'

const templateCategorySchema = z.enum(TEMPLATE_CATEGORIES)

// Desktop Foreman company intake (E11 / Round 35 C).
// Reuses the original onboarding questions, order, lists and copy from onboarding-intake.
// Mac additions: workspace/chat-scoped durable draft + step, revision-bound saves, and one
// idempotent explicit completion that hands answers to Foreman discovery/chat authority.
// Viewing, restoring or remounting never completes. No signup, payment or hosted account path.

export const DESKTOP_FOREMAN_INTAKE_CONTRACT_VERSION = 1 as const

export {
    EMPTY_DRAFT,
    INTAKE_COPY,
    INTAKE_INDUSTRIES,
    INTAKE_STEPS,
    DEFAULT_ROLES,
    furthestReachable,
    industryHint,
    intakeSteps,
    looksLikeSite,
    rolesForIndustry,
    stepAnswered,
    toIntake,
}
export type { IntakeDraft, IntakeStep, ForemanIntakeRequest, TemplateCategory, DesktopForemanChatRef }

export const desktopForemanIntakeDraftSchema = z.strictObject({
    companyUrl: z.string().max(500),
    websiteSkipped: z.boolean(),
    industry: templateCategorySchema.nullable(),
    industryLabel: z.string().max(200),
    position: z.string().max(200),
    firstName: z.string().max(100),
})
export type DesktopForemanIntakeDraft = z.infer<typeof desktopForemanIntakeDraftSchema>

export const desktopForemanIntakeSessionSchema = z.strictObject({
    chat: foremanChatRefSchema,
    revision: z.number().int().min(0),
    stepIndex: z.number().int().min(0).max(INTAKE_STEPS.length),
    draft: desktopForemanIntakeDraftSchema,
    /** Fast industry guess while they keep answering; never inferred from unrelated accounts. */
    decidedIndustry: templateCategorySchema.nullable(),
    /** Account/header first name when one already exists; null asks the name step. */
    knownFirstName: z.string().max(100).nullable(),
    updatedAt: z.string().min(1),
})
export type DesktopForemanIntakeSession = z.infer<typeof desktopForemanIntakeSessionSchema>

export const desktopForemanIntakeSaveInputSchema = z.strictObject({
    chat: foremanChatRefSchema,
    requestId: z.uuid(),
    baseRevision: z.number().int().min(0),
    stepIndex: z.number().int().min(0).max(INTAKE_STEPS.length),
    draft: desktopForemanIntakeDraftSchema,
    decidedIndustry: templateCategorySchema.nullable(),
    knownFirstName: z.string().max(100).nullable(),
})
export type DesktopForemanIntakeSaveInput = z.infer<typeof desktopForemanIntakeSaveInputSchema>

export const DESKTOP_FOREMAN_INTAKE_COMPLETION_STATES = ['pending', 'acknowledged', 'failed', 'unavailable'] as const
export const desktopForemanIntakeCompletionStateSchema = z.enum(DESKTOP_FOREMAN_INTAKE_COMPLETION_STATES)
export type DesktopForemanIntakeCompletionState = z.infer<typeof desktopForemanIntakeCompletionStateSchema>

export const desktopForemanIntakeAnswersSchema = foremanIntakeSchema
export type DesktopForemanIntakeAnswers = ForemanIntakeRequest

export const desktopForemanIntakeCompleteInputSchema = z.strictObject({
    chat: foremanChatRefSchema,
    requestId: z.uuid(),
    /** Must match the durable session revision that produced these answers. */
    expectedRevision: z.number().int().min(0),
    answers: desktopForemanIntakeAnswersSchema,
})
export type DesktopForemanIntakeCompleteInput = z.infer<typeof desktopForemanIntakeCompleteInputSchema>

export const desktopForemanIntakeCompletionReceiptSchema = z.strictObject({
    requestId: z.uuid(),
    chat: foremanChatRefSchema,
    fingerprint: z.string().min(1).max(128),
    state: desktopForemanIntakeCompletionStateSchema,
    answers: desktopForemanIntakeAnswersSchema,
    /** Present only when the canonical Foreman authority acknowledged delivery. */
    followUp: z
        .strictObject({
            conversationId: z.string().min(1).max(128).nullable(),
            runId: z.string().min(1).max(128).nullable(),
            industry: templateCategorySchema.nullable(),
        })
        .nullable(),
    error: z.string().max(500).nullable(),
    /** Named missing authority when state is unavailable — never a pretend success. */
    missingAuthority: z.string().max(200).nullable(),
    createdAt: z.string().min(1),
    updatedAt: z.string().min(1),
})
export type DesktopForemanIntakeCompletionReceipt = z.infer<typeof desktopForemanIntakeCompletionReceiptSchema>

export const desktopForemanIntakeViewSchema = z.strictObject({
    session: desktopForemanIntakeSessionSchema,
    completion: desktopForemanIntakeCompletionReceiptSchema.nullable(),
})
export type DesktopForemanIntakeView = z.infer<typeof desktopForemanIntakeViewSchema>

export const desktopForemanIntakeConflictSchema = z.strictObject({
    kind: z.literal('revision_conflict'),
    view: desktopForemanIntakeViewSchema,
    message: z.string(),
})
export type DesktopForemanIntakeConflict = z.infer<typeof desktopForemanIntakeConflictSchema>

/** Public completion payload A/B may consume without editing this package. */
export const desktopForemanIntakePublishedCompletionSchema = z.strictObject({
    contractVersion: z.literal(DESKTOP_FOREMAN_INTAKE_CONTRACT_VERSION),
    chat: foremanChatRefSchema,
    requestId: z.uuid(),
    fingerprint: z.string().min(1).max(128),
    state: z.literal('acknowledged'),
    answers: desktopForemanIntakeAnswersSchema,
    industry: templateCategorySchema.nullable(),
    completedAt: z.string().min(1),
})
export type DesktopForemanIntakePublishedCompletion = z.infer<typeof desktopForemanIntakePublishedCompletionSchema>

export function publishDesktopForemanIntakeCompletion(
    receipt: DesktopForemanIntakeCompletionReceipt,
): DesktopForemanIntakePublishedCompletion | null {
    if (receipt.state !== 'acknowledged') return null
    return {
        contractVersion: DESKTOP_FOREMAN_INTAKE_CONTRACT_VERSION,
        chat: receipt.chat,
        requestId: receipt.requestId,
        fingerprint: receipt.fingerprint,
        state: 'acknowledged',
        answers: receipt.answers,
        industry: receipt.followUp?.industry ?? receipt.answers.industry ?? receipt.answers.decidedIndustry,
        completedAt: receipt.updatedAt,
    }
}

/** Root-bound authority that writes the profile and opens Foreman discovery/plan. */
export type DesktopForemanIntakeCompletionAuthority = {
    deliver(input: {
        chat: DesktopForemanChatRef
        requestId: string
        fingerprint: string
        answers: ForemanIntakeRequest
    }): Promise<{
        conversationId: string | null
        runId: string | null
        industry: TemplateCategory | null
    }>
    lookup(requestId: string): Promise<{
        fingerprint: string
        conversationId: string | null
        runId: string | null
        industry: TemplateCategory | null
    } | null>
}

/** Optional fast industry decision (original decideIndustryAction). Missing → null, never invented. */
export type DesktopForemanIntakeIndustryAuthority = {
    decide(input: string): Promise<TemplateCategory | null>
}

/** Optional early site read for the board (original streamLiveDiscoveries). Fire-and-forget. */
export type DesktopForemanIntakeSiteAuthority = {
    analyze(url: string): void
}

export type DesktopForemanIntakeKnownNameAuthority = {
    readKnownFirstName(chat: DesktopForemanChatRef): Promise<string | null>
}

export const DESKTOP_FOREMAN_INTAKE_MISSING = {
    completion: 'DesktopForemanIntakeCompletionAuthority',
    industry: 'DesktopForemanIntakeIndustryAuthority',
    site: 'DesktopForemanIntakeSiteAuthority',
    knownName: 'DesktopForemanIntakeKnownNameAuthority',
    database: 'DesktopForemanIntakeSqliteStore',
} as const

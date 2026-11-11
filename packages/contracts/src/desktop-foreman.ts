import { z } from 'zod'
import { desktopTemplateRevisionSchema } from './desktop-templates.js'

// Local Foreman (E11). Renderer DTOs carry opaque local identities only: no engine ids, provider
// credentials, connection secrets or host paths. Compatibility: version 1. Additive fields only;
// a breaking change bumps DESKTOP_FOREMAN_CONTRACT_VERSION and is recorded in the round33 I handoff.

export const DESKTOP_FOREMAN_CONTRACT_VERSION = 1 as const

export const DESKTOP_FOREMAN_LIMITS = {
    maxBoxes: 5,
    maxItems: 8,
    maxGets: 3,
    maxTitle: 120,
    maxName: 60,
    maxRole: 240,
    maxLine: 240,
    maxFeedback: 4_000,
    maxDiscoveryPages: 4,
    maxDiscoveryFindings: 24,
    discoveryDeadlineMs: 45_000,
} as const

const opaque = (prefix: string) => z.string().regex(new RegExp(`^${prefix}_[A-Za-z0-9-]{8,80}$`))
export const foremanWorkspaceIdSchema = z.string().min(1).max(128)
export const foremanChatIdSchema = opaque('fmc')
export const foremanRunIdSchema = z.string().min(1).max(128)
export const foremanPlanIdSchema = opaque('fmp')
export const foremanRevisionIdSchema = opaque('fmr')
export const foremanDecisionIdSchema = opaque('fmd')
export const foremanBuildIdSchema = opaque('fmb')
export const foremanDigestSchema = z.string().regex(/^[a-f0-9]{64}$/)
export const foremanQuestionGuardSchema = z.strictObject({
    runId: z.uuid(),
    sourceMessageId: z.string().min(1).max(256),
    toolCallId: z.string().min(1).max(256),
    digest: foremanDigestSchema,
})
export type DesktopForemanQuestionGuard = z.infer<typeof foremanQuestionGuardSchema>

// The original phases, minus the hosted-only waitlist and trial steps (no billing on desktop).
export const DESKTOP_FOREMAN_PHASES = ['discover', 'plan', 'build', 'companion'] as const
export const desktopForemanPhaseSchema = z.enum(DESKTOP_FOREMAN_PHASES)
export type DesktopForemanPhase = z.infer<typeof desktopForemanPhaseSchema>

// The model choice the run was admitted on, by local connection id. Never a key or token.
export const foremanModelRefSchema = z.strictObject({ connectionId: z.string().min(1).max(256), model: z.string().min(1).max(512) })
export type DesktopForemanModelRef = z.infer<typeof foremanModelRefSchema>

export const foremanBindingSchema = z.strictObject({
    workspaceId: foremanWorkspaceIdSchema,
    chatId: foremanChatIdSchema,
    runId: foremanRunIdSchema,
    model: foremanModelRefSchema,
})
export type DesktopForemanBinding = z.infer<typeof foremanBindingSchema>
export const foremanChatRefSchema = z.strictObject({ workspaceId: foremanWorkspaceIdSchema, chatId: foremanChatIdSchema })
export type DesktopForemanChatRef = z.infer<typeof foremanChatRefSchema>

// Engine and app server only. Renderer requests continue to use their saved message ID.
export const foremanReplyTargetSchema = foremanChatRefSchema.extend({
    sessionId: z.uuid(),
    assistantMessageId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
})
export const foremanReplySourceSchema = foremanReplyTargetSchema.extend({
    sourceRunId: z.uuid(),
    precedingUserMessageId: foremanReplyTargetSchema.shape.assistantMessageId,
    replyDigest: foremanDigestSchema,
    transcriptRevision: foremanDigestSchema,
})
export const foremanAlternateRequestSchema = foremanReplyTargetSchema.extend({
    requestId: z.uuid(),
    transcriptRevision: foremanDigestSchema,
})
export type ForemanAlternateRequest = z.infer<typeof foremanAlternateRequestSchema>
export const foremanAlternateReservationSchema = z.strictObject({
    requestId: z.uuid(),
    sessionId: z.uuid(),
    runId: z.uuid(),
    userMessageId: foremanReplyTargetSchema.shape.assistantMessageId,
    source: foremanReplySourceSchema,
})
export const foremanAlternateRunActionSchema = z.enum(['start', 'stop', 'status'])
export const foremanAlternateRunRequestSchema = z.strictObject({
    action: foremanAlternateRunActionSchema,
    chat: foremanChatRefSchema,
    requestId: z.uuid(),
})
export type ForemanAlternateRunRequest = z.infer<typeof foremanAlternateRunRequestSchema>
export const foremanAlternateRunSchema = z.strictObject({
    sessionId: z.uuid(),
    runId: z.uuid(),
    status: z.enum(['prepared', 'running', 'done', 'error', 'cancelled']),
})

const line = (max: number) => z.string().trim().min(1).max(max)

// Original show_plan shape (apps/ui/lib/foreman/tool-defs.ts planItemsSchema), with a local
// template id in place of a hosted slug. Shared-link items are unsupported locally.
export const foremanPlanBeatsSchema = z.strictObject({ trigger: line(DESKTOP_FOREMAN_LIMITS.maxLine), working: line(DESKTOP_FOREMAN_LIMITS.maxLine), delivered: line(DESKTOP_FOREMAN_LIMITS.maxLine) })
export const foremanAgentItemSchema = z.strictObject({
    kind: z.literal('agent'),
    name: line(DESKTOP_FOREMAN_LIMITS.maxName),
    role: line(DESKTOP_FOREMAN_LIMITS.maxRole),
    need: line(DESKTOP_FOREMAN_LIMITS.maxLine).optional(),
    when: line(DESKTOP_FOREMAN_LIMITS.maxLine).optional(),
    beats: foremanPlanBeatsSchema.optional(),
    gets: z.array(line(DESKTOP_FOREMAN_LIMITS.maxLine)).max(DESKTOP_FOREMAN_LIMITS.maxGets).optional(),
    box: line(DESKTOP_FOREMAN_LIMITS.maxName).optional(),
})
export const foremanTemplateItemSchema = z.strictObject({
    kind: z.literal('template'),
    templateId: z.string().min(1).max(128),
    title: line(DESKTOP_FOREMAN_LIMITS.maxTitle).optional(),
    focus: line(DESKTOP_FOREMAN_LIMITS.maxLine).optional(),
    box: line(DESKTOP_FOREMAN_LIMITS.maxName).optional(),
})
export const foremanPlanItemSchema = z.discriminatedUnion('kind', [foremanAgentItemSchema, foremanTemplateItemSchema])
export const foremanPlanBoxSchema = z.strictObject({ name: line(DESKTOP_FOREMAN_LIMITS.maxName), role: line(DESKTOP_FOREMAN_LIMITS.maxLine).optional() })
export type DesktopForemanPlanItem = z.infer<typeof foremanPlanItemSchema>
export type DesktopForemanPlanBox = z.infer<typeof foremanPlanBoxSchema>

const nameKey = (name: string) => name.trim().toLowerCase()

// Mirrors readPlanItems/readPlanBoxes refusals: a template is never mixed with designed coworkers,
// Box names are unique, and an item's box must be one the card lays out.
export const foremanShowPlanInputSchema = z
    .strictObject({
        title: line(DESKTOP_FOREMAN_LIMITS.maxTitle),
        boxes: z.array(foremanPlanBoxSchema).max(DESKTOP_FOREMAN_LIMITS.maxBoxes).default([]),
        items: z.array(foremanPlanItemSchema).min(1).max(DESKTOP_FOREMAN_LIMITS.maxItems),
    })
    .superRefine((plan, ctx) => {
        const kinds = new Set(plan.items.map(item => item.kind))
        if (kinds.size > 1) ctx.addIssue({ code: 'custom', message: 'A plan that installs a template holds nothing else: drop the coworker items.' })
        const boxes = plan.boxes.map(box => nameKey(box.name))
        if (new Set(boxes).size !== boxes.length) ctx.addIssue({ code: 'custom', message: 'Each Box appears once.' })
        const names = plan.items.flatMap(item => (item.kind === 'agent' ? [nameKey(item.name)] : []))
        if (new Set(names).size !== names.length) ctx.addIssue({ code: 'custom', message: 'Each coworker on the card has its own name.' })
        if (boxes.length) for (const item of plan.items) if (item.box && !boxes.includes(nameKey(item.box))) ctx.addIssue({ code: 'custom', message: `"${item.box}" is not one of the Boxes on the card.` })
    })
export type DesktopForemanShowPlanInput = z.infer<typeof foremanShowPlanInputSchema>

// Stable package-local keys assigned by the app when the revision is sealed, in card order.
export const foremanItemKeySchema = z.string().regex(/^item-[0-9]{1,2}$/)
export const foremanBoxKeySchema = z.string().regex(/^box-[0-9]{1,2}$/)
export const foremanSealedPlanSchema = z.strictObject({
    title: z.string(),
    boxes: z.array(foremanPlanBoxSchema.extend({ key: foremanBoxKeySchema })),
    items: z.array(z.intersection(z.discriminatedUnion('kind', [
        foremanAgentItemSchema,
        foremanTemplateItemSchema.extend({ templateRevision: desktopTemplateRevisionSchema.optional() }),
    ]), z.object({ key: foremanItemKeySchema, boxKey: foremanBoxKeySchema }))),
})
export type DesktopForemanSealedPlan = z.infer<typeof foremanSealedPlanSchema>

export const FOREMAN_REVISION_STATES = ['shown', 'confirmed', 'changes_requested', 'superseded'] as const
const foremanStarterPlanSourceSchema = z.strictObject({ offerId: z.uuid(), digest: foremanDigestSchema })
export const foremanRevisionSchema = z.strictObject({
    planId: foremanPlanIdSchema,
    revisionId: foremanRevisionIdSchema,
    revision: z.number().int().min(1),
    digest: foremanDigestSchema,
    chat: foremanChatRefSchema,
    runId: foremanRunIdSchema.nullable(),
    toolCallId: z.string().min(1).max(256).nullable(),
    model: foremanModelRefSchema.nullable(),
    starter: foremanStarterPlanSourceSchema.optional(),
    plan: foremanSealedPlanSchema,
    state: z.enum(FOREMAN_REVISION_STATES),
    shownAt: z.string(),
}).refine(value => value.starter
    ? value.runId === null && value.toolCallId === null && value.model === null
        && value.plan.items.length > 0 && value.plan.items.every(item => item.kind === 'template' && !!item.templateRevision)
    : value.runId !== null && value.toolCallId !== null && value.model !== null
        && value.plan.items.every(item => item.kind !== 'template' || !item.templateRevision),
{ message: 'The plan must name its engine call or its saved starter offer.' })
export type DesktopForemanRevision = z.infer<typeof foremanRevisionSchema>

// Decisions only come from the user's explicit click on the exact displayed revision.
// There is deliberately no model-callable confirm tool and no "origin" a run can claim.
export const foremanDecisionInputSchema = z.discriminatedUnion('decision', [
    z.strictObject({ decision: z.literal('confirm'), requestId: z.uuid(), chat: foremanChatRefSchema, planId: foremanPlanIdSchema, revisionId: foremanRevisionIdSchema, digest: foremanDigestSchema }),
    z.strictObject({ decision: z.literal('ask_changes'), requestId: z.uuid(), chat: foremanChatRefSchema, planId: foremanPlanIdSchema, revisionId: foremanRevisionIdSchema, digest: foremanDigestSchema, feedback: line(DESKTOP_FOREMAN_LIMITS.maxFeedback) }),
])
export type DesktopForemanDecisionInput = z.infer<typeof foremanDecisionInputSchema>
export const FOREMAN_DECISION_STATES = ['pending', 'acknowledged', 'failed', 'uncertain'] as const
export const foremanDecisionSchema = z.strictObject({
    decisionId: foremanDecisionIdSchema,
    requestId: z.uuid(),
    revisionId: foremanRevisionIdSchema,
    decision: z.enum(['confirm', 'ask_changes']),
    state: z.enum(FOREMAN_DECISION_STATES),
    feedback: z.string().nullable(),
    followUpRunId: foremanRunIdSchema.nullable(),
    buildId: foremanBuildIdSchema.nullable(),
    error: z.string().nullable(),
    decidedAt: z.string(),
})
export type DesktopForemanDecision = z.infer<typeof foremanDecisionSchema>

export const FOREMAN_ITEM_STATES = ['queued', 'reserved', 'creating', 'created', 'failed', 'uncertain', 'stopped'] as const
export type DesktopForemanItemState = (typeof FOREMAN_ITEM_STATES)[number]
export const FOREMAN_BUILD_STATES = ['reserved', 'running', 'completed', 'partial', 'stopped', 'failed', 'uncertain'] as const
export type DesktopForemanBuildState = (typeof FOREMAN_BUILD_STATES)[number]
export const FOREMAN_BUILD_FAILURES = ['model_unavailable', 'workspace_changed', 'replaced', 'deleted', 'creation_failed', 'template_failed', 'box_failed', 'interrupted', 'authority_missing'] as const

export const foremanCreatedRefSchema = z.strictObject({ agentIds: z.array(z.string().min(1).max(128)), spaceId: z.string().min(1).max(128), sessionId: z.string().min(1).max(128).nullable() })
export const foremanBuildItemSchema = z.strictObject({
    itemKey: foremanItemKeySchema,
    order: z.number().int().min(0),
    kind: z.enum(['agent', 'template']),
    title: z.string(),
    boxKey: foremanBoxKeySchema,
    state: z.enum(FOREMAN_ITEM_STATES),
    created: foremanCreatedRefSchema.nullable(),
    failure: z.enum(FOREMAN_BUILD_FAILURES).nullable(),
    error: z.string().nullable(),
    lead: z.boolean(),
})
export type DesktopForemanBuildItem = z.infer<typeof foremanBuildItemSchema>
export const foremanBuildBoxSchema = z.strictObject({ boxKey: foremanBoxKeySchema, name: z.string(), state: z.enum(['queued', 'creating', 'created', 'failed', 'uncertain', 'stopped']), spaceId: z.string().nullable() })
export const foremanBuildSchema = z.strictObject({
    buildId: foremanBuildIdSchema,
    decisionId: foremanDecisionIdSchema,
    revisionId: foremanRevisionIdSchema,
    state: z.enum(FOREMAN_BUILD_STATES),
    boxes: z.array(foremanBuildBoxSchema),
    items: z.array(foremanBuildItemSchema),
    leadItemKey: foremanItemKeySchema.nullable(),
    setup: z.strictObject({ state: z.enum(['not_started', 'pending', 'started', 'failed', 'uncertain', 'unavailable']), agentId: z.string().nullable(), sessionId: z.string().nullable(), error: z.string().nullable() }),
    startedAt: z.string(),
    updatedAt: z.string(),
})
export type DesktopForemanBuild = z.infer<typeof foremanBuildSchema>

export const foremanBuildActionSchema = z.discriminatedUnion('action', [
    z.strictObject({ action: z.literal('stop'), requestId: z.uuid(), chat: foremanChatRefSchema, buildId: foremanBuildIdSchema }),
    z.strictObject({ action: z.literal('resume'), requestId: z.uuid(), chat: foremanChatRefSchema, buildId: foremanBuildIdSchema }),
    z.strictObject({ action: z.literal('start_lead_setup'), requestId: z.uuid(), chat: foremanChatRefSchema, buildId: foremanBuildIdSchema, itemKey: foremanItemKeySchema }),
])
export type DesktopForemanBuildAction = z.infer<typeof foremanBuildActionSchema>

// Discovery: original vocabulary (apps/ui/lib/company/explore/findings.ts), restricted to the
// collectors the desktop can run with already-authorized public fetch. Missing collectors are
// reported as `unavailable`, never filled in.
export const DESKTOP_DISCOVERY_SOURCES = ['profile', 'site', 'search', 'stack', 'dns', 'registry', 'linkedinPerson', 'linkedinCompany', 'googleBusiness', 'catalog', 'synthesis'] as const
export const foremanDiscoverySourceSchema = z.enum(DESKTOP_DISCOVERY_SOURCES)
export type DesktopDiscoverySource = z.infer<typeof foremanDiscoverySourceSchema>
export const foremanAttributionSchema = z.strictObject({ url: z.url().max(2048), fetchedAt: z.string() })
export const foremanFindingSchema = z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('identity'), source: foremanDiscoverySourceSchema, attribution: foremanAttributionSchema, name: z.string().max(200), oneLiner: z.string().max(400).nullable(), logoUrl: z.null(), domain: z.string().max(253) }),
    z.strictObject({ kind: z.literal('audience'), source: foremanDiscoverySourceSchema, attribution: foremanAttributionSchema, text: z.string().max(400) }),
    z.strictObject({ kind: z.literal('products'), source: foremanDiscoverySourceSchema, attribution: foremanAttributionSchema, items: z.array(z.string().max(120)).max(12) }),
    z.strictObject({ kind: z.literal('customers'), source: foremanDiscoverySourceSchema, attribution: foremanAttributionSchema, items: z.array(z.string().max(120)).max(12) }),
    z.strictObject({ kind: z.literal('competitors'), source: foremanDiscoverySourceSchema, attribution: foremanAttributionSchema, items: z.array(z.string().max(120)).max(12) }),
])
export type DesktopForemanFinding = z.infer<typeof foremanFindingSchema>
export const foremanDiscoveryEventSchema = z.discriminatedUnion('type', [
    z.strictObject({ type: z.literal('pending'), source: foremanDiscoverySourceSchema }),
    z.strictObject({ type: z.literal('found'), source: foremanDiscoverySourceSchema, findings: z.array(foremanFindingSchema).max(DESKTOP_FOREMAN_LIMITS.maxDiscoveryFindings) }),
    z.strictObject({ type: z.literal('dropped'), source: foremanDiscoverySourceSchema, reason: z.enum(['failed', 'timeout', 'blocked', 'empty']).optional() }),
    z.strictObject({ type: z.literal('unavailable'), source: foremanDiscoverySourceSchema }),
    z.strictObject({ type: z.literal('end') }),
])
export type DesktopForemanDiscoveryEvent = z.infer<typeof foremanDiscoveryEventSchema>
export const foremanDiscoveryRunSchema = z.strictObject({
    discoveryId: z.string().regex(/^fmx_[A-Za-z0-9-]{8,80}$/),
    chat: foremanChatRefSchema,
    runId: foremanRunIdSchema,
    url: z.url(),
    status: z.enum(['running', 'done', 'failed', 'stopped']),
    pending: z.array(foremanDiscoverySourceSchema),
    unavailable: z.array(foremanDiscoverySourceSchema),
    findings: z.array(foremanFindingSchema),
})
export type DesktopForemanDiscoveryRun = z.infer<typeof foremanDiscoveryRunSchema>

// Original transient FOREMAN_INTENT_PART: delivered once to the live observer and never replayed.
export const foremanNavigationIntentSchema = z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('open_coworker'), agentId: z.string().min(1).max(128), sessionId: z.string().min(1).max(128).nullable() }),
    z.strictObject({ kind: z.literal('open_box'), spaceId: z.string().min(1).max(128) }),
    z.strictObject({ kind: z.literal('open_setup'), agentId: z.string().min(1).max(128) }),
])
export const foremanLiveEventSchema = z.discriminatedUnion('type', [
    z.strictObject({ type: z.literal('navigation'), binding: foremanBindingSchema, intent: foremanNavigationIntentSchema, eventId: z.string().min(1).max(128) }),
    z.strictObject({ type: z.literal('plan_shown'), binding: foremanBindingSchema, revisionId: foremanRevisionIdSchema }),
    z.strictObject({ type: z.literal('build_progress'), chat: foremanChatRefSchema, build: foremanBuildSchema }),
    z.strictObject({ type: z.literal('discovery'), chat: foremanChatRefSchema, runId: foremanRunIdSchema, discoveryId: z.string(), event: foremanDiscoveryEventSchema }),
])
export type DesktopForemanLiveEvent = z.infer<typeof foremanLiveEventSchema>

// What H renders. `live` is the trusted current run, null for a saved/historical view: a
// projection with live=null cannot produce navigation, setup or discovery effects.
export const foremanConversationViewSchema = z.strictObject({
    contractVersion: z.literal(DESKTOP_FOREMAN_CONTRACT_VERSION),
    chat: foremanChatRefSchema,
    phase: desktopForemanPhaseSchema,
    live: z.strictObject({ runId: foremanRunIdSchema, model: foremanModelRefSchema }).nullable(),
    revisions: z.array(foremanRevisionSchema),
    currentRevisionId: foremanRevisionIdSchema.nullable(),
    decisions: z.array(foremanDecisionSchema),
    build: foremanBuildSchema.nullable(),
    discovery: foremanDiscoveryRunSchema.nullable(),
    blocked: z.enum(['decision_uncertain', 'build_uncertain', 'setup_uncertain']).nullable(),
})
export type DesktopForemanConversationView = z.infer<typeof foremanConversationViewSchema>

export const foremanErrorSchema = z.strictObject({
    code: z.enum(['stale_revision', 'digest_mismatch', 'not_live', 'conflict', 'uncertain', 'invalid_plan', 'authority_missing', 'model_unavailable', 'not_found']),
    message: z.string(),
})
export type DesktopForemanError = z.infer<typeof foremanErrorSchema>

// Pure discovery reducer: a port of applyDiscoveryEvent/applyToRow for both the runtime row and
// H's overlay. Unavailable sources leave a visible marker; nothing is synthesised.
export function applyForemanDiscoveryEvent(row: DesktopForemanDiscoveryRun, event: DesktopForemanDiscoveryEvent): DesktopForemanDiscoveryRun {
    if (event.type === 'end') return { ...row, status: row.status === 'running' ? 'done' : row.status, pending: [] }
    if (event.type === 'pending') return row.pending.includes(event.source) ? row : { ...row, pending: [...row.pending, event.source] }
    const pending = row.pending.filter(source => source !== event.source)
    if (event.type === 'dropped') return { ...row, pending }
    if (event.type === 'unavailable') return { ...row, pending, unavailable: row.unavailable.includes(event.source) ? row.unavailable : [...row.unavailable, event.source] }
    const kinds = new Set(event.findings.map(finding => finding.kind))
    return { ...row, pending, findings: [...row.findings.filter(finding => !kinds.has(finding.kind)), ...event.findings].slice(0, DESKTOP_FOREMAN_LIMITS.maxDiscoveryFindings) }
}

export const DESKTOP_FOREMAN_SOURCE_LABELS: Record<DesktopDiscoverySource, string> = {
    profile: 'Your website', stack: 'Your website', site: 'Your website', dns: 'Your domain', registry: 'Public registry', search: 'The web',
    linkedinPerson: 'LinkedIn', linkedinCompany: 'LinkedIn', googleBusiness: 'Google', catalog: 'Your website', synthesis: 'Rerun',
}

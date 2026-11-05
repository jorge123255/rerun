import { z } from 'zod'
import { providerSchema } from './agent.js'
import { triggerMethodSchema } from './trigger.js'

export const desktopTriggerMethodSchema = triggerMethodSchema
export type DesktopTriggerMethod = z.infer<typeof desktopTriggerMethodSchema>

export const DESKTOP_TRIGGER_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/

export const desktopTriggerRevisionSchema = z.string().min(1).max(128)
export const desktopTriggerRequestIdSchema = z.string().uuid()

/** Public management view. Token is included only on authenticated owner reads after an explicit create/rotate/get; model tools must never see it. */
export const desktopTriggerSchema = z.object({
    slug: z.string().regex(DESKTOP_TRIGGER_SLUG_RE),
    name: z.string().min(1).max(120),
    description: z.string().max(4000).default(''),
    enabled: z.boolean(),
    methods: z.array(desktopTriggerMethodSchema).min(1),
    lastFiredAt: z.string().nullable(),
    fireCount: z.number().int().nonnegative(),
    connectionId: z.string().nullable(),
    provider: providerSchema.nullable(),
    model: z.string().nullable(),
    body: z.string().default(''),
    createdAt: z.string(),
    revision: desktopTriggerRevisionSchema,
    /** Present only when the authenticated management API intentionally returns a secret. Never in list/history. */
    token: z.string().optional(),
    /** Null when ingress origin is disabled/unresolved. Never invent a public host. */
    url: z.string().url().nullable().optional(),
})
export type DesktopTrigger = z.infer<typeof desktopTriggerSchema>

export const desktopTriggerPublicSchema = desktopTriggerSchema.omit({ token: true })
export type DesktopTriggerPublic = z.infer<typeof desktopTriggerPublicSchema>

export const desktopTriggerCreateSchema = z.object({
    requestId: desktopTriggerRequestIdSchema,
    name: z.string().min(1).max(120),
    description: z.string().max(4000).default(''),
    body: z.string().min(1).max(64000),
    methods: z.array(desktopTriggerMethodSchema).min(1).default(['POST']),
    enabled: z.boolean().optional(),
    connectionId: z.string().nullable().optional(),
    provider: providerSchema.nullable().default(null),
    model: z.string().nullable().default(null),
}).strict()
export type DesktopTriggerCreate = z.infer<typeof desktopTriggerCreateSchema>

export const desktopTriggerUpdateSchema = z.object({
    requestId: desktopTriggerRequestIdSchema,
    expectedRevision: desktopTriggerRevisionSchema,
    description: z.string().max(4000).optional(),
    body: z.string().min(1).max(64000).optional(),
    methods: z.array(desktopTriggerMethodSchema).min(1).optional(),
    enabled: z.boolean().optional(),
    connectionId: z.string().nullable().optional(),
    provider: providerSchema.nullable().optional(),
    model: z.string().nullable().optional(),
}).strict()
export type DesktopTriggerUpdate = z.infer<typeof desktopTriggerUpdateSchema>

export const desktopTriggerMutateSchema = z.object({
    requestId: desktopTriggerRequestIdSchema,
    expectedRevision: desktopTriggerRevisionSchema,
}).strict()

export const desktopTriggerDeliveryStatusSchema = z.enum([
    'accepted',
    'running',
    'finished',
    'cancelled',
    'error',
    'refused',
    'uncertain',
    'needs-input',
])
export type DesktopTriggerDeliveryStatus = z.infer<typeof desktopTriggerDeliveryStatusSchema>

/** Durable delivery identity. Independent webhook calls never share eventId. Exact retries share attemptFingerprint. */
export const desktopTriggerDeliveryReceiptSchema = z.object({
    eventId: z.string().min(1).max(80),
    attemptFingerprint: z.string().min(1).max(200).nullable(),
    localAgentId: z.string().min(1).max(200),
    engineAgentId: z.string().min(1).max(200),
    slug: z.string().regex(DESKTOP_TRIGGER_SLUG_RE),
    triggerName: z.string(),
    method: desktopTriggerMethodSchema,
    receivedAt: z.string(),
    status: desktopTriggerDeliveryStatusSchema,
    localSessionId: z.string().nullable(),
    engineSessionId: z.string().nullable(),
    runId: z.string().nullable(),
    revision: desktopTriggerRevisionSchema,
    error: z.string().nullable(),
    payloadBytes: z.number().int().nonnegative(),
    truncated: z.boolean(),
    capturedPayload: z.boolean(),
})
export type DesktopTriggerDeliveryReceipt = z.infer<typeof desktopTriggerDeliveryReceiptSchema>

export const desktopTriggerFireInputSchema = z.object({
    token: z.string().min(1),
    method: desktopTriggerMethodSchema,
    query: z.string().default(''),
    contentType: z.string().default(''),
    body: z.string().default(''),
    bodyBytes: z.number().int().nonnegative().default(0),
    /** Explicit same-attempt retry identity. Never inferred from matching bodies. */
    attemptFingerprint: z.string().min(1).max(200).optional(),
}).strict()
export type DesktopTriggerFireInput = z.infer<typeof desktopTriggerFireInputSchema>

export const desktopTriggerStopSchema = z.object({
    requestId: desktopTriggerRequestIdSchema,
    localSessionId: z.string().min(1).max(200),
    runId: z.string().min(1).max(200),
    expectedEventId: z.string().min(1).max(80).optional(),
}).strict()
export type DesktopTriggerStop = z.infer<typeof desktopTriggerStopSchema>

export const desktopTriggerHistoryItemSchema = z.object({
    eventId: z.string(),
    slug: z.string(),
    triggerName: z.string(),
    status: desktopTriggerDeliveryStatusSchema,
    receivedAt: z.string(),
    finishedAt: z.string().nullable(),
    localSessionId: z.string().nullable(),
    runId: z.string().nullable(),
    error: z.string().nullable(),
    /** True when bounded payload text was persisted with the event; false for live-only updates. */
    capturedPayload: z.boolean(),
    liveOnly: z.boolean().default(false),
})
export type DesktopTriggerHistoryItem = z.infer<typeof desktopTriggerHistoryItemSchema>

export const desktopTriggerChatSchema = z.object({
    agentId: z.string(),
    engineAgentId: z.string(),
    sessionId: z.string(),
    engineSessionId: z.string(),
    tabUid: z.string(),
    title: z.string(),
    runId: z.string().nullable(),
})
export type DesktopTriggerChat = z.infer<typeof desktopTriggerChatSchema>

export const desktopTriggerIngressOriginSchema = z.object({
    enabled: z.boolean(),
    /** Loopback by default. Null origin means URLs are unavailable. */
    origin: z.string().url().nullable(),
    bindHost: z.enum(['127.0.0.1', '::1']).default('127.0.0.1'),
    bindPort: z.number().int().positive().nullable().default(null),
    hostingDecision: z.enum(['unresolved', 'loopback-only', 'external-pending-root']).default('unresolved'),
}).strict()
export type DesktopTriggerIngressOrigin = z.infer<typeof desktopTriggerIngressOriginSchema>

export const DESKTOP_TRIGGER_MAX_INGRESS_BODY_BYTES = 1_048_576
export const DESKTOP_TRIGGER_MAX_MODEL_PAYLOAD_BYTES = 65_536

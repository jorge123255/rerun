import { z } from 'zod'
export const DESKTOP_CUSTOM_PROVIDER_VERSION = 1 as const
export const registeredCustomConnectionIdSchema = z.uuidv4()
export const CUSTOM_DEFAULT_CONTEXT_WINDOW = 128_000
export const DESKTOP_XAI_BASE_URL = 'https://api.x.ai/v1'
export const DESKTOP_CUSTOM_PRESETS = [
    { id: 'ollama', label: 'Ollama', baseUrl: 'http://localhost:11434/v1', keyRequired: false, local: true },
    { id: 'lmstudio', label: 'LM Studio', baseUrl: 'http://localhost:1234/v1', keyRequired: false, local: true },
    { id: 'vllm', label: 'vLLM', baseUrl: 'http://localhost:8000/v1', keyRequired: false, local: true },
    { id: 'litellm', label: 'LiteLLM', baseUrl: 'http://localhost:4000/v1', keyRequired: true, local: true },
    { id: 'groq', label: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', keyRequired: true, local: false },
    { id: 'together', label: 'Together', baseUrl: 'https://api.together.xyz/v1', keyRequired: true, local: false },
    { id: 'mistral', label: 'Mistral', baseUrl: 'https://api.mistral.ai/v1', keyRequired: true, local: false },
    { id: 'deepseek', label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', keyRequired: true, local: false },
    { id: 'xai', label: 'Grok (xAI API)', baseUrl: DESKTOP_XAI_BASE_URL, keyRequired: true, local: false },
    { id: 'kimi-platform', label: 'Kimi Platform API', baseUrl: 'https://api.moonshot.ai/v1', keyRequired: true, local: false },
] as const
const customProviderPresetSchema = z.enum(DESKTOP_CUSTOM_PRESETS.map(preset => preset.id))
const endpoint = z.url().max(2048).refine(value => { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash }, 'Use a plain HTTP(S) endpoint without credentials, query or fragment.')
const opaque = z.string().min(1).max(256)
export const customProviderIdentitySchema = z.strictObject({ workspaceId: z.number().int().positive(), connectionId: opaque, revision: z.number().int().positive() })
export type CustomProviderIdentity = z.infer<typeof customProviderIdentitySchema>
export const xaiReasoningLevel = z.enum(['low', 'medium', 'high', 'xhigh'])
export const customProviderReasoningSchema = z.strictObject({
    supported: z.array(xaiReasoningLevel).min(1).max(4),
    default: xaiReasoningLevel.optional(),
}).refine(value => value.default === undefined || value.supported.includes(value.default))
export const customProviderModelSchema = z.strictObject({ id: opaque, contextWindow: z.number().int().min(256).max(10_000_000).nullable(), vision: z.boolean().default(false), source: z.enum(['discovered', 'manual']), reasoning: customProviderReasoningSchema.optional() })
export type CustomProviderModel = z.infer<typeof customProviderModelSchema>
export const customEndpointPolicySchema = z.strictObject({ reviewedOrigin: endpoint.refine(value => { const url = new URL(value); return url.pathname === '/' }, 'Review an exact origin.'), allowHttp: z.boolean().default(false), allowPrivate: z.boolean().default(false) })
export const customProviderConfigSchema = z.strictObject({ name: z.string().trim().min(1).max(60), baseUrl: endpoint, preset: customProviderPresetSchema.nullable(), models: z.array(customProviderModelSchema).min(1).max(256), contextWindow: z.number().int().min(256).max(10_000_000).nullable(), vision: z.boolean(), policy: customEndpointPolicySchema })
export type CustomProviderConfig = z.infer<typeof customProviderConfigSchema>
export const customProviderSnapshotSchema = customProviderIdentitySchema.extend({ config: customProviderConfigSchema, configuredSecret: z.boolean(), state: z.enum(['configured','disconnected']), catalog: z.strictObject({ status: z.enum(['never','fresh','stale','unavailable','empty']), models: z.array(customProviderModelSchema).max(256), observedAt: z.number().nullable(), attemptedAt: z.number().nullable() }) }).strict()
export type CustomProviderSnapshot = z.infer<typeof customProviderSnapshotSchema>
export const customProviderChangeSchema = z.discriminatedUnion('action', [
    z.strictObject({ action: z.literal('create'), requestId: z.uuid(), workspaceId: z.number().int().positive(), connectionId: opaque, config: customProviderConfigSchema, apiKey: z.string().max(8192).optional() }),
    z.strictObject({ action: z.literal('update'), requestId: z.uuid(), identity: customProviderIdentitySchema, config: customProviderConfigSchema, apiKey: z.string().max(8192).optional(), clearSecret: z.boolean().default(false) }),
    z.strictObject({ action: z.literal('disconnect'), requestId: z.uuid(), identity: customProviderIdentitySchema }),
])
export type CustomProviderChange = z.infer<typeof customProviderChangeSchema>
export const customProviderReceiptSchema = z.strictObject({ requestId: z.uuid(), identity: customProviderIdentitySchema, action: z.enum(['create','update','disconnect']), status: z.enum(['recorded','uncertain']), recovered: z.boolean() })
export type CustomProviderReceipt = z.infer<typeof customProviderReceiptSchema>
export const customProviderProblemSchema = z.enum(['unreachable','unauthorized','not_listed','model_refused','policy_refused','stale_revision','unavailable','cancelled','invalid'])
export const customProviderProbeSchema = z.strictObject({ identity: customProviderIdentitySchema, status: z.enum(['fresh','empty','unavailable']), models: z.array(customProviderModelSchema).max(256), problem: customProviderProblemSchema.nullable(), manualModel: opaque.nullable(), manualUsable: z.boolean(), observedAt: z.number() })
export type CustomProviderProbe = z.infer<typeof customProviderProbeSchema>
export const customProviderDraftProbeSchema = z.strictObject({
    action: z.literal('probe_draft'), requestId: z.uuid(), workspaceId: z.number().int().positive(),
    baseUrl: endpoint, policy: customEndpointPolicySchema, apiKey: z.string().max(8192).optional(), manualModel: opaque.optional(),
})
export type CustomProviderDraftProbe = z.infer<typeof customProviderDraftProbeSchema>
export const customProviderRequestSchema = z.discriminatedUnion('action', [
    customProviderDraftProbeSchema,
    z.strictObject({ action: z.literal('read'), identity: customProviderIdentitySchema }),
    z.strictObject({ action: z.literal('probe'), identity: customProviderIdentitySchema, manualModel: opaque.optional() }),
    z.strictObject({ action: z.literal('change'), change: customProviderChangeSchema }),
])
export type CustomProviderRequest = z.infer<typeof customProviderRequestSchema>
/** Existing connection authority owns atomic revisions, encrypted credentials and permanent replay receipts. */
export type CustomProviderAuthority = {
    read(identity: CustomProviderIdentity, signal: AbortSignal): Promise<CustomProviderSnapshot>
    credential(identity: CustomProviderIdentity, signal: AbortSignal): Promise<string | null>
    assertCurrent(identity: CustomProviderIdentity, signal: AbortSignal): Promise<void>
    change(change: CustomProviderChange, signal: AbortSignal): Promise<CustomProviderReceipt>
    recordProbe(identity: CustomProviderIdentity, result: CustomProviderProbe, signal: AbortSignal): Promise<void>
    subscribe(listener: (identity: CustomProviderIdentity) => void): () => void
}

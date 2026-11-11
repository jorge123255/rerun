import { z } from 'zod'
import { desktopWorkspaceIdSchema } from './desktop-workspaces.js'

// OpenCode Go and Console for the desktop. Version 1. The barrel export is a root fragment.
// This is not an OpenRouter endpoint and it does not accept a ChatGPT credential.
// Console and free Go models start off. Free models require an explicit enable on the connection.

export const DESKTOP_OPENCODE_CONTRACT_VERSION = 1 as const
export const DESKTOP_OPENCODE_PROVIDER = 'opencode' as const
export const DESKTOP_OPENCODE_TOKEN_KEY = 'OPENCODE_API_KEY' as const
export const DESKTOP_OPENCODE_PLANS = ['go', 'console'] as const
export type DesktopOpencodePlan = (typeof DESKTOP_OPENCODE_PLANS)[number]
export type DesktopOpencodeWire = 'anthropic' | 'responses' | 'chat' | 'google'

export const DESKTOP_OPENCODE_CATALOG_URL: Record<DesktopOpencodePlan, string> = {
    go: 'https://opencode.ai/inference/go/v1/models',
    console: 'https://opencode.ai/inference/v1/models',
}
export const DESKTOP_OPENCODE_USAGE_URL = 'https://opencode.ai/zen/go/v1/usage'
export const DESKTOP_OPENCODE_SESSION_HEADER = 'x-opencode-session'
export const DESKTOP_OPENCODE_ORIGIN = 'https://opencode.ai/'
export const DESKTOP_OPENCODE_DEFAULT_MODEL = 'go/deepseek-v4-pro'
export const DESKTOP_OPENCODE_ONE_SHOT_SESSION = 'agent-oc:one-shot'
export const DESKTOP_OPENCODE_CREDITS_USED_UP = 'OpenCode Console credits used up'
export const DESKTOP_OPENCODE_GO_LIMIT = 'OpenCode Go limit reached'
export const DESKTOP_OPENCODE_MAX_OUTPUT_TOKENS = 32_000
export const DESKTOP_OPENCODE_CATALOG_STALE_MS = 30 * 60_000
export const DESKTOP_OPENCODE_USAGE_STALE_MS = 5 * 60_000

const WIRE_OF_STYLE: Record<string, DesktopOpencodeWire> = {
    messages: 'anthropic',
    responses: 'responses',
    'chat-completions': 'chat',
    'generate-content': 'google',
}

export const desktopOpencodeModelSchema = z.strictObject({
    id: z.string().min(1),
    upstreamId: z.string().min(1),
    plan: z.enum(DESKTOP_OPENCODE_PLANS),
    label: z.string().min(1),
    wire: z.enum(['anthropic', 'responses', 'chat', 'google']),
    baseUrl: z.string().startsWith(DESKTOP_OPENCODE_ORIGIN),
    contextWindow: z.number().positive(),
    outputLimit: z.number().positive(),
    images: z.boolean(),
    reasoning: z.boolean(),
    price: z.strictObject({
        input: z.number().nonnegative(),
        output: z.number().nonnegative(),
        cacheRead: z.number().nonnegative().nullable(),
    }),
})
export type DesktopOpencodeModel = z.infer<typeof desktopOpencodeModelSchema>

const catalogEntrySchema = z.object({
    id: z.string().min(1),
    name: z.string().min(1),
    type: z.string(),
    modalities: z.object({ input: z.array(z.string()).default([]) }).optional(),
    capabilities: z.object({
        tools: z.object({ supported: z.boolean() }),
        reasoning: z.object({ supported: z.boolean() }).optional(),
    }),
    limit: z.object({ context: z.number().positive(), input: z.number().positive().optional(), output: z.number().positive() }),
    cost: z.object({
        text: z.object({
            input: z.object({ price: z.number().nonnegative(), cache: z.object({ read: z.number().nonnegative().optional() }).optional() }),
            output: z.object({ price: z.number().nonnegative() }),
        }),
    }),
    api: z.record(z.string(), z.object({ base_url: z.string() })),
})

export function desktopOpencodeModelId(plan: DesktopOpencodePlan, upstreamId: string): string {
    return `${plan}/${upstreamId}`
}

export function desktopOpencodePlanOf(id: string): DesktopOpencodePlan | null {
    return DESKTOP_OPENCODE_PLANS.find(plan => id.startsWith(`${plan}/`)) ?? null
}

export function desktopOpencodeUpstreamId(id: string): string {
    const plan = desktopOpencodePlanOf(id)
    return plan ? id.slice(plan.length + 1) : id
}

export function isFreeDesktopOpencodeModel(price: Pick<DesktopOpencodeModel['price'], 'input' | 'output'>): boolean {
    return price.input === 0 && price.output === 0
}

export function desktopOpencodeModelEnabled(model: DesktopOpencodeModel, enabledModelIds?: readonly string[]): boolean {
    return enabledModelIds?.includes(model.id) ?? !isFreeDesktopOpencodeModel(model.price)
}

function entryToModel(entry: z.infer<typeof catalogEntrySchema>, plan: DesktopOpencodePlan): DesktopOpencodeModel | null {
    if (entry.type !== 'chat' || !entry.capabilities.tools.supported) return null
    const { input, output } = entry.cost.text
    if (plan === 'console' && isFreeDesktopOpencodeModel({ input: input.price, output: output.price })) return null
    const styles = Object.entries(entry.api).filter(([style]) => WIRE_OF_STYLE[style])
    if (styles.length !== 1) return null
    const [style, { base_url: baseUrl }] = styles[0]!
    if (!baseUrl.startsWith(DESKTOP_OPENCODE_ORIGIN)) return null
    return {
        id: desktopOpencodeModelId(plan, entry.id),
        upstreamId: entry.id,
        plan,
        label: entry.name,
        wire: WIRE_OF_STYLE[style]!,
        baseUrl: baseUrl.replace(/\/+$/, ''),
        contextWindow: entry.limit.input ?? entry.limit.context,
        outputLimit: entry.limit.output,
        images: (entry.modalities?.input ?? []).some(kind => kind === 'image' || kind.startsWith('image/')),
        reasoning: entry.capabilities.reasoning?.supported ?? false,
        price: { input: input.price, output: output.price, cacheRead: input.cache?.read ?? null },
    }
}

// One invalid entry is skipped. Sorted by id, matching the shipped snapshot.
export function parseDesktopOpencodeCatalog(json: unknown, plan: DesktopOpencodePlan): DesktopOpencodeModel[] {
    const data = (json as { data?: unknown } | null)?.data
    if (!Array.isArray(data)) return []
    const models: DesktopOpencodeModel[] = []
    const seen = new Set<string>()
    for (const raw of data) {
        const parsed = catalogEntrySchema.safeParse(raw)
        if (!parsed.success) continue
        const model = entryToModel(parsed.data, plan)
        if (!model || seen.has(model.id)) continue
        seen.add(model.id)
        models.push(model)
    }
    return models.sort((a, b) => a.id.localeCompare(b.id))
}

// Shipped public catalogs parsed by the original snapshot generator. Not a live provider response.
export const DESKTOP_OPENCODE_SNAPSHOT: DesktopOpencodeModel[] = [
    {"id":"go/beam-free","upstreamId":"beam-free","plan":"go","label":"Beam Free","wire":"chat","baseUrl":"https://opencode.ai/inference/go/openai/v1","contextWindow":1048576,"outputLimit":131072,"images":false,"reasoning":true,"price":{"input":0,"output":0,"cacheRead":0}},
    {"id":"go/claude-haiku-5-5","upstreamId":"claude-haiku-5-5","plan":"go","label":"Claude Haiku 5.5","wire":"anthropic","baseUrl":"https://opencode.ai/inference/go/anthropic/v1","contextWindow":1000000,"outputLimit":128000,"images":true,"reasoning":true,"price":{"input":0.1,"output":0.5,"cacheRead":0.01}},
    {"id":"go/deepseek-v4-pro","upstreamId":"deepseek-v4-pro","plan":"go","label":"DeepSeek V4 Pro","wire":"chat","baseUrl":"https://opencode.ai/inference/go/openai/v1","contextWindow":1000000,"outputLimit":384000,"images":false,"reasoning":true,"price":{"input":0.66,"output":1.98,"cacheRead":0.022}},
    {"id":"go/deepseek-v4.1-flash","upstreamId":"deepseek-v4.1-flash","plan":"go","label":"DeepSeek V4.1 Flash 1017","wire":"chat","baseUrl":"https://opencode.ai/inference/go/openai/v1","contextWindow":1000000,"outputLimit":384000,"images":true,"reasoning":true,"price":{"input":0.15,"output":0.6,"cacheRead":0.003}},
    {"id":"go/gemini-4-argon","upstreamId":"gemini-4-argon","plan":"go","label":"Gemini 4 Argon","wire":"google","baseUrl":"https://opencode.ai/inference/go/google/v1beta","contextWindow":1048576,"outputLimit":65536,"images":true,"reasoning":true,"price":{"input":2,"output":10,"cacheRead":0.1}},
    {"id":"go/glm-5.2","upstreamId":"glm-5.2","plan":"go","label":"GLM-5.2","wire":"chat","baseUrl":"https://opencode.ai/inference/go/openai/v1","contextWindow":1000000,"outputLimit":131072,"images":false,"reasoning":true,"price":{"input":1.4,"output":4.4,"cacheRead":0.26}},
    {"id":"go/glm-5.3","upstreamId":"glm-5.3","plan":"go","label":"GLM-5.3","wire":"chat","baseUrl":"https://opencode.ai/inference/go/openai/v1","contextWindow":1000000,"outputLimit":131072,"images":false,"reasoning":true,"price":{"input":1.4,"output":4.4,"cacheRead":0.26}},
    {"id":"go/glm-5.3-flash","upstreamId":"glm-5.3-flash","plan":"go","label":"GLM-5.3-Flash","wire":"chat","baseUrl":"https://opencode.ai/inference/go/openai/v1","contextWindow":1000000,"outputLimit":131072,"images":true,"reasoning":true,"price":{"input":0.15,"output":0.5,"cacheRead":0.03}},
    {"id":"go/gpt-5.6-luna","upstreamId":"gpt-5.6-luna","plan":"go","label":"GPT-5.6 Luna","wire":"responses","baseUrl":"https://opencode.ai/inference/go/openai/v1","contextWindow":922000,"outputLimit":128000,"images":true,"reasoning":true,"price":{"input":0.2,"output":1.2,"cacheRead":0.02}},
    {"id":"go/gpt-6-luna","upstreamId":"gpt-6-luna","plan":"go","label":"GPT-6 Luna","wire":"responses","baseUrl":"https://opencode.ai/inference/go/openai/v1","contextWindow":922000,"outputLimit":128000,"images":true,"reasoning":true,"price":{"input":0.1,"output":0.5,"cacheRead":0.01}},
    {"id":"go/grok-4.7","upstreamId":"grok-4.7","plan":"go","label":"Grok 4.7","wire":"responses","baseUrl":"https://opencode.ai/inference/go/openai/v1","contextWindow":500000,"outputLimit":500000,"images":true,"reasoning":true,"price":{"input":2,"output":6,"cacheRead":0.5}},
    {"id":"go/hy3","upstreamId":"hy3","plan":"go","label":"Hy3","wire":"chat","baseUrl":"https://opencode.ai/inference/go/openai/v1","contextWindow":192000,"outputLimit":128000,"images":false,"reasoning":true,"price":{"input":0.14,"output":0.58,"cacheRead":0.035}},
    {"id":"go/hy4","upstreamId":"hy4","plan":"go","label":"Hy4","wire":"chat","baseUrl":"https://opencode.ai/inference/go/openai/v1","contextWindow":983010,"outputLimit":65536,"images":true,"reasoning":true,"price":{"input":0.834,"output":2.501,"cacheRead":0.042}},
    {"id":"go/hy4-preview","upstreamId":"hy4-preview","plan":"go","label":"Hy4 preview","wire":"chat","baseUrl":"https://opencode.ai/inference/go/openai/v1","contextWindow":1024000,"outputLimit":64000,"images":false,"reasoning":true,"price":{"input":0.834,"output":2.501,"cacheRead":0.042}},
    {"id":"go/iceman-contributor-free","upstreamId":"iceman-contributor-free","plan":"go","label":"Iceman Contributor Free","wire":"chat","baseUrl":"https://opencode.ai/inference/go/openai/v1","contextWindow":262144,"outputLimit":131072,"images":false,"reasoning":true,"price":{"input":0,"output":0,"cacheRead":0}},
    {"id":"go/kimi-k2.7-code","upstreamId":"kimi-k2.7-code","plan":"go","label":"Kimi K2.7 Code","wire":"chat","baseUrl":"https://opencode.ai/inference/go/openai/v1","contextWindow":262144,"outputLimit":262144,"images":true,"reasoning":true,"price":{"input":0.95,"output":4,"cacheRead":0.19}},
    {"id":"go/kimi-k3","upstreamId":"kimi-k3","plan":"go","label":"Kimi K3","wire":"chat","baseUrl":"https://opencode.ai/inference/go/openai/v1","contextWindow":1048576,"outputLimit":131072,"images":true,"reasoning":true,"price":{"input":3,"output":15,"cacheRead":0.3}},
    {"id":"go/kimi-k3.1-pro","upstreamId":"kimi-k3.1-pro","plan":"go","label":"Kimi K3.1 Pro","wire":"chat","baseUrl":"https://opencode.ai/inference/go/openai/v1","contextWindow":1048576,"outputLimit":131072,"images":true,"reasoning":true,"price":{"input":2,"output":10,"cacheRead":0.2}},
    {"id":"go/longcat-2.0","upstreamId":"longcat-2.0","plan":"go","label":"LongCat-2.0","wire":"chat","baseUrl":"https://opencode.ai/inference/go/openai/v1","contextWindow":1000000,"outputLimit":131072,"images":false,"reasoning":true,"price":{"input":0.3,"output":1.2,"cacheRead":0.006}},
    {"id":"go/longcat-2.5-free","upstreamId":"longcat-2.5-free","plan":"go","label":"LongCat 2.5 Free","wire":"chat","baseUrl":"https://opencode.ai/inference/go/openai/v1","contextWindow":1000000,"outputLimit":262144,"images":true,"reasoning":true,"price":{"input":0,"output":0,"cacheRead":0}},
    {"id":"go/mimo-v2.6-flash","upstreamId":"mimo-v2.6-flash","plan":"go","label":"MiMo-V2.6-Flash","wire":"chat","baseUrl":"https://opencode.ai/inference/go/openai/v1","contextWindow":1048576,"outputLimit":131072,"images":true,"reasoning":true,"price":{"input":0.14,"output":0.28,"cacheRead":0.0028}},
    {"id":"go/mimo-v2.6-pro","upstreamId":"mimo-v2.6-pro","plan":"go","label":"MiMo-V2.6-Pro","wire":"chat","baseUrl":"https://opencode.ai/inference/go/openai/v1","contextWindow":1048576,"outputLimit":131072,"images":true,"reasoning":true,"price":{"input":0.435,"output":0.87,"cacheRead":0.003625}},
    {"id":"go/minimax-m3","upstreamId":"minimax-m3","plan":"go","label":"MiniMax-M3","wire":"anthropic","baseUrl":"https://opencode.ai/inference/go/anthropic/v1","contextWindow":1000000,"outputLimit":131072,"images":true,"reasoning":true,"price":{"input":0.3,"output":1.2,"cacheRead":0.06}},
    {"id":"go/minimax-m3.1-flash","upstreamId":"minimax-m3.1-flash","plan":"go","label":"MiniMax M3.1 Flash","wire":"chat","baseUrl":"https://opencode.ai/inference/go/openai/v1","contextWindow":1000000,"outputLimit":512000,"images":true,"reasoning":true,"price":{"input":0.15,"output":0.6,"cacheRead":0.015}},
    {"id":"go/muse-spark-1.2-contributor","upstreamId":"muse-spark-1.2-contributor","plan":"go","label":"Muse Spark 1.2 Contributor","wire":"responses","baseUrl":"https://opencode.ai/inference/go/openai/v1","contextWindow":1048576,"outputLimit":131072,"images":true,"reasoning":true,"price":{"input":0.1,"output":0.2,"cacheRead":0.002}},
    {"id":"go/muse-spark-1.3-contributor","upstreamId":"muse-spark-1.3-contributor","plan":"go","label":"Muse Spark 1.3 Contributor","wire":"responses","baseUrl":"https://opencode.ai/inference/go/openai/v1","contextWindow":1048576,"outputLimit":131072,"images":true,"reasoning":true,"price":{"input":0.1,"output":0.2,"cacheRead":0.002}},
    {"id":"go/qwen3.7-plus","upstreamId":"qwen3.7-plus","plan":"go","label":"Qwen3.7 Plus","wire":"anthropic","baseUrl":"https://opencode.ai/inference/go/anthropic/v1","contextWindow":1000000,"outputLimit":65536,"images":true,"reasoning":true,"price":{"input":0.4,"output":1.6,"cacheRead":0.04}},
    {"id":"go/qwen3.8-flash","upstreamId":"qwen3.8-flash","plan":"go","label":"Qwen3.8 Flash","wire":"anthropic","baseUrl":"https://opencode.ai/inference/go/anthropic/v1","contextWindow":1000000,"outputLimit":131072,"images":true,"reasoning":true,"price":{"input":0.15,"output":0.47,"cacheRead":0.016}},
    {"id":"go/qwen3.8-max","upstreamId":"qwen3.8-max","plan":"go","label":"Qwen3.8 Max","wire":"anthropic","baseUrl":"https://opencode.ai/inference/go/anthropic/v1","contextWindow":1000000,"outputLimit":131072,"images":true,"reasoning":true,"price":{"input":2,"output":6,"cacheRead":0.25}},
    {"id":"go/step-5-preview","upstreamId":"step-5-preview","plan":"go","label":"Step 5 Preview","wire":"chat","baseUrl":"https://opencode.ai/inference/go/openai/v1","contextWindow":1000000,"outputLimit":65536,"images":true,"reasoning":true,"price":{"input":1,"output":2.7,"cacheRead":0.1}},
    {"id":"console/claude-fable-5","upstreamId":"claude-fable-5","plan":"console","label":"Claude Fable 5","wire":"anthropic","baseUrl":"https://opencode.ai/inference/anthropic/v1","contextWindow":1000000,"outputLimit":128000,"images":true,"reasoning":true,"price":{"input":10,"output":50,"cacheRead":1}},
    {"id":"console/claude-fable-5-1","upstreamId":"claude-fable-5-1","plan":"console","label":"Claude Fable 5.1","wire":"anthropic","baseUrl":"https://opencode.ai/inference/anthropic/v1","contextWindow":1000000,"outputLimit":128000,"images":true,"reasoning":true,"price":{"input":10,"output":50,"cacheRead":0.25}},
    {"id":"console/claude-fable-5-2","upstreamId":"claude-fable-5-2","plan":"console","label":"Claude Fable 5.2","wire":"anthropic","baseUrl":"https://opencode.ai/inference/anthropic/v1","contextWindow":1000000,"outputLimit":128000,"images":true,"reasoning":true,"price":{"input":8,"output":40,"cacheRead":0.2}},
    {"id":"console/claude-haiku-4-5","upstreamId":"claude-haiku-4-5","plan":"console","label":"Claude Haiku 4.5","wire":"anthropic","baseUrl":"https://opencode.ai/inference/anthropic/v1","contextWindow":200000,"outputLimit":64000,"images":true,"reasoning":true,"price":{"input":1,"output":5,"cacheRead":0.1}},
    {"id":"console/claude-haiku-5-5","upstreamId":"claude-haiku-5-5","plan":"console","label":"Claude Haiku 5.5","wire":"anthropic","baseUrl":"https://opencode.ai/inference/anthropic/v1","contextWindow":1000000,"outputLimit":128000,"images":true,"reasoning":true,"price":{"input":0.1,"output":0.5,"cacheRead":0.01}},
    {"id":"console/claude-opus-4-5","upstreamId":"claude-opus-4-5","plan":"console","label":"Claude Opus 4.5","wire":"anthropic","baseUrl":"https://opencode.ai/inference/anthropic/v1","contextWindow":200000,"outputLimit":64000,"images":true,"reasoning":true,"price":{"input":5,"output":25,"cacheRead":0.5}},
    {"id":"console/claude-opus-4-6","upstreamId":"claude-opus-4-6","plan":"console","label":"Claude Opus 4.6","wire":"anthropic","baseUrl":"https://opencode.ai/inference/anthropic/v1","contextWindow":1000000,"outputLimit":128000,"images":true,"reasoning":true,"price":{"input":5,"output":25,"cacheRead":0.5}},
    {"id":"console/claude-opus-4-7","upstreamId":"claude-opus-4-7","plan":"console","label":"Claude Opus 4.7","wire":"anthropic","baseUrl":"https://opencode.ai/inference/anthropic/v1","contextWindow":1000000,"outputLimit":128000,"images":true,"reasoning":true,"price":{"input":5,"output":25,"cacheRead":0.5}},
    {"id":"console/claude-opus-4-8","upstreamId":"claude-opus-4-8","plan":"console","label":"Claude Opus 4.8","wire":"anthropic","baseUrl":"https://opencode.ai/inference/anthropic/v1","contextWindow":1000000,"outputLimit":128000,"images":true,"reasoning":true,"price":{"input":5,"output":25,"cacheRead":0.5}},
    {"id":"console/claude-opus-5","upstreamId":"claude-opus-5","plan":"console","label":"Claude Opus 5","wire":"anthropic","baseUrl":"https://opencode.ai/inference/anthropic/v1","contextWindow":1000000,"outputLimit":128000,"images":true,"reasoning":true,"price":{"input":5,"output":25,"cacheRead":0.5}},
    {"id":"console/claude-opus-5-5","upstreamId":"claude-opus-5-5","plan":"console","label":"Claude Opus 5.5","wire":"anthropic","baseUrl":"https://opencode.ai/inference/anthropic/v1","contextWindow":1000000,"outputLimit":128000,"images":true,"reasoning":true,"price":{"input":4,"output":20,"cacheRead":0.2}},
    {"id":"console/claude-sonnet-4-5","upstreamId":"claude-sonnet-4-5","plan":"console","label":"Claude Sonnet 4.5","wire":"anthropic","baseUrl":"https://opencode.ai/inference/anthropic/v1","contextWindow":1000000,"outputLimit":64000,"images":true,"reasoning":true,"price":{"input":3,"output":15,"cacheRead":0.3}},
    {"id":"console/claude-sonnet-4-6","upstreamId":"claude-sonnet-4-6","plan":"console","label":"Claude Sonnet 4.6","wire":"anthropic","baseUrl":"https://opencode.ai/inference/anthropic/v1","contextWindow":1000000,"outputLimit":64000,"images":true,"reasoning":true,"price":{"input":3,"output":15,"cacheRead":0.3}},
    {"id":"console/claude-sonnet-5","upstreamId":"claude-sonnet-5","plan":"console","label":"Claude Sonnet 5","wire":"anthropic","baseUrl":"https://opencode.ai/inference/anthropic/v1","contextWindow":1000000,"outputLimit":128000,"images":true,"reasoning":true,"price":{"input":2,"output":10,"cacheRead":0.2}},
    {"id":"console/claude-sonnet-5-5","upstreamId":"claude-sonnet-5-5","plan":"console","label":"Claude Sonnet 5.5","wire":"anthropic","baseUrl":"https://opencode.ai/inference/anthropic/v1","contextWindow":1000000,"outputLimit":128000,"images":true,"reasoning":true,"price":{"input":2,"output":10,"cacheRead":0.1}},
    {"id":"console/deepseek-v4-pro","upstreamId":"deepseek-v4-pro","plan":"console","label":"DeepSeek V4 Pro","wire":"chat","baseUrl":"https://opencode.ai/inference/openai/v1","contextWindow":1000000,"outputLimit":384000,"images":false,"reasoning":true,"price":{"input":1.74,"output":3.48,"cacheRead":0.145}},
    {"id":"console/deepseek-v4.1-flash","upstreamId":"deepseek-v4.1-flash","plan":"console","label":"DeepSeek V4.1 Flash 1017","wire":"chat","baseUrl":"https://opencode.ai/inference/openai/v1","contextWindow":1000000,"outputLimit":384000,"images":true,"reasoning":true,"price":{"input":0.3,"output":1.2,"cacheRead":0.006}},
    {"id":"console/gemini-3.5-flash","upstreamId":"gemini-3.5-flash","plan":"console","label":"Gemini 3.5 Flash","wire":"google","baseUrl":"https://opencode.ai/inference/google/v1beta","contextWindow":1048576,"outputLimit":65536,"images":true,"reasoning":true,"price":{"input":1.5,"output":9,"cacheRead":0.15}},
    {"id":"console/gemini-3.5-flash-lite","upstreamId":"gemini-3.5-flash-lite","plan":"console","label":"Gemini 3.5 Flash Lite","wire":"google","baseUrl":"https://opencode.ai/inference/google/v1beta","contextWindow":1048576,"outputLimit":65536,"images":true,"reasoning":true,"price":{"input":0.3,"output":2.5,"cacheRead":0.03}},
    {"id":"console/gemini-3.6-flash","upstreamId":"gemini-3.6-flash","plan":"console","label":"Gemini 3.6 Flash","wire":"google","baseUrl":"https://opencode.ai/inference/google/v1beta","contextWindow":1048576,"outputLimit":65536,"images":true,"reasoning":true,"price":{"input":0.75,"output":3.75,"cacheRead":0.075}},
    {"id":"console/gemini-3.7-flash","upstreamId":"gemini-3.7-flash","plan":"console","label":"Gemini 3.7 Flash","wire":"google","baseUrl":"https://opencode.ai/inference/google/v1beta","contextWindow":1048576,"outputLimit":65536,"images":true,"reasoning":true,"price":{"input":0.75,"output":3.75,"cacheRead":0.075}},
    {"id":"console/gemini-3.8-flash","upstreamId":"gemini-3.8-flash","plan":"console","label":"Gemini 3.8 Flash","wire":"google","baseUrl":"https://opencode.ai/inference/google/v1beta","contextWindow":1048576,"outputLimit":65536,"images":true,"reasoning":true,"price":{"input":0.75,"output":3.75,"cacheRead":0.075}},
    {"id":"console/gemini-4-argon","upstreamId":"gemini-4-argon","plan":"console","label":"Gemini 4 Argon","wire":"google","baseUrl":"https://opencode.ai/inference/google/v1beta","contextWindow":1048576,"outputLimit":65536,"images":true,"reasoning":true,"price":{"input":2,"output":10,"cacheRead":0.1}},
    {"id":"console/gemini-4-carbon","upstreamId":"gemini-4-carbon","plan":"console","label":"Gemini 4 Carbon","wire":"google","baseUrl":"https://opencode.ai/inference/google/v1beta","contextWindow":1048576,"outputLimit":65536,"images":true,"reasoning":true,"price":{"input":2,"output":10,"cacheRead":0.1}},
    {"id":"console/glm-5","upstreamId":"glm-5","plan":"console","label":"GLM-5","wire":"chat","baseUrl":"https://opencode.ai/inference/openai/v1","contextWindow":204800,"outputLimit":131072,"images":false,"reasoning":true,"price":{"input":1,"output":3.2,"cacheRead":0.2}},
    {"id":"console/glm-5.1","upstreamId":"glm-5.1","plan":"console","label":"GLM-5.1","wire":"chat","baseUrl":"https://opencode.ai/inference/openai/v1","contextWindow":204800,"outputLimit":131072,"images":false,"reasoning":true,"price":{"input":1.4,"output":4.4,"cacheRead":0.26}},
    {"id":"console/glm-5.2","upstreamId":"glm-5.2","plan":"console","label":"GLM-5.2","wire":"chat","baseUrl":"https://opencode.ai/inference/openai/v1","contextWindow":1000000,"outputLimit":131072,"images":false,"reasoning":true,"price":{"input":1.4,"output":4.4,"cacheRead":0.26}},
    {"id":"console/glm-5.3","upstreamId":"glm-5.3","plan":"console","label":"GLM-5.3","wire":"chat","baseUrl":"https://opencode.ai/inference/openai/v1","contextWindow":1000000,"outputLimit":131072,"images":false,"reasoning":true,"price":{"input":1.4,"output":4.4,"cacheRead":0.26}},
    {"id":"console/glm-5.3-flash","upstreamId":"glm-5.3-flash","plan":"console","label":"GLM-5.3-Flash","wire":"chat","baseUrl":"https://opencode.ai/inference/openai/v1","contextWindow":1000000,"outputLimit":131072,"images":true,"reasoning":true,"price":{"input":0.15,"output":0.5,"cacheRead":0.03}},
    {"id":"console/gpt-5","upstreamId":"gpt-5","plan":"console","label":"GPT-5","wire":"responses","baseUrl":"https://opencode.ai/inference/openai/v1","contextWindow":272000,"outputLimit":128000,"images":true,"reasoning":true,"price":{"input":1.07,"output":8.5,"cacheRead":0.107}},
    {"id":"console/gpt-5-codex","upstreamId":"gpt-5-codex","plan":"console","label":"GPT-5 Codex","wire":"responses","baseUrl":"https://opencode.ai/inference/openai/v1","contextWindow":272000,"outputLimit":128000,"images":true,"reasoning":true,"price":{"input":1.07,"output":8.5,"cacheRead":0.107}},
    {"id":"console/gpt-5-nano","upstreamId":"gpt-5-nano","plan":"console","label":"GPT-5 Nano","wire":"responses","baseUrl":"https://opencode.ai/inference/openai/v1","contextWindow":272000,"outputLimit":128000,"images":true,"reasoning":true,"price":{"input":0.05,"output":0.4,"cacheRead":0.005}},
    {"id":"console/gpt-5.1","upstreamId":"gpt-5.1","plan":"console","label":"GPT-5.1","wire":"responses","baseUrl":"https://opencode.ai/inference/openai/v1","contextWindow":272000,"outputLimit":128000,"images":true,"reasoning":true,"price":{"input":1.07,"output":8.5,"cacheRead":0.107}},
    {"id":"console/gpt-5.1-codex","upstreamId":"gpt-5.1-codex","plan":"console","label":"GPT-5.1 Codex","wire":"responses","baseUrl":"https://opencode.ai/inference/openai/v1","contextWindow":272000,"outputLimit":128000,"images":true,"reasoning":true,"price":{"input":1.07,"output":8.5,"cacheRead":0.107}},
    {"id":"console/gpt-5.1-codex-max","upstreamId":"gpt-5.1-codex-max","plan":"console","label":"GPT-5.1 Codex Max","wire":"responses","baseUrl":"https://opencode.ai/inference/openai/v1","contextWindow":272000,"outputLimit":128000,"images":true,"reasoning":true,"price":{"input":1.25,"output":10,"cacheRead":0.125}},
    {"id":"console/gpt-5.1-codex-mini","upstreamId":"gpt-5.1-codex-mini","plan":"console","label":"GPT-5.1 Codex Mini","wire":"responses","baseUrl":"https://opencode.ai/inference/openai/v1","contextWindow":272000,"outputLimit":128000,"images":true,"reasoning":true,"price":{"input":0.25,"output":2,"cacheRead":0.025}},
    {"id":"console/gpt-5.2","upstreamId":"gpt-5.2","plan":"console","label":"GPT-5.2","wire":"responses","baseUrl":"https://opencode.ai/inference/openai/v1","contextWindow":272000,"outputLimit":128000,"images":true,"reasoning":true,"price":{"input":1.75,"output":14,"cacheRead":0.175}},
    {"id":"console/gpt-5.2-codex","upstreamId":"gpt-5.2-codex","plan":"console","label":"GPT-5.2 Codex","wire":"responses","baseUrl":"https://opencode.ai/inference/openai/v1","contextWindow":272000,"outputLimit":128000,"images":true,"reasoning":true,"price":{"input":1.75,"output":14,"cacheRead":0.175}},
    {"id":"console/gpt-5.3-codex","upstreamId":"gpt-5.3-codex","plan":"console","label":"GPT-5.3 Codex","wire":"responses","baseUrl":"https://opencode.ai/inference/openai/v1","contextWindow":272000,"outputLimit":128000,"images":true,"reasoning":true,"price":{"input":1.75,"output":14,"cacheRead":0.175}},
    {"id":"console/gpt-5.3-codex-spark","upstreamId":"gpt-5.3-codex-spark","plan":"console","label":"GPT-5.3 Codex Spark","wire":"responses","baseUrl":"https://opencode.ai/inference/openai/v1","contextWindow":128000,"outputLimit":128000,"images":false,"reasoning":true,"price":{"input":1.75,"output":14,"cacheRead":0.175}},
    {"id":"console/gpt-5.4","upstreamId":"gpt-5.4","plan":"console","label":"GPT-5.4","wire":"responses","baseUrl":"https://opencode.ai/inference/openai/v1","contextWindow":922000,"outputLimit":128000,"images":true,"reasoning":true,"price":{"input":2.5,"output":15,"cacheRead":0.25}},
    {"id":"console/gpt-5.4-mini","upstreamId":"gpt-5.4-mini","plan":"console","label":"GPT-5.4 Mini","wire":"responses","baseUrl":"https://opencode.ai/inference/openai/v1","contextWindow":272000,"outputLimit":128000,"images":true,"reasoning":true,"price":{"input":0.75,"output":4.5,"cacheRead":0.075}},
    {"id":"console/gpt-5.4-nano","upstreamId":"gpt-5.4-nano","plan":"console","label":"GPT-5.4 Nano","wire":"responses","baseUrl":"https://opencode.ai/inference/openai/v1","contextWindow":272000,"outputLimit":128000,"images":true,"reasoning":true,"price":{"input":0.2,"output":1.25,"cacheRead":0.02}},
    {"id":"console/gpt-5.4-pro","upstreamId":"gpt-5.4-pro","plan":"console","label":"GPT-5.4 Pro","wire":"responses","baseUrl":"https://opencode.ai/inference/openai/v1","contextWindow":922000,"outputLimit":128000,"images":true,"reasoning":true,"price":{"input":30,"output":180,"cacheRead":30}},
    {"id":"console/gpt-5.5","upstreamId":"gpt-5.5","plan":"console","label":"GPT-5.5","wire":"responses","baseUrl":"https://opencode.ai/inference/openai/v1","contextWindow":922000,"outputLimit":128000,"images":true,"reasoning":true,"price":{"input":5,"output":30,"cacheRead":0.5}},
    {"id":"console/gpt-5.5-pro","upstreamId":"gpt-5.5-pro","plan":"console","label":"GPT-5.5 Pro","wire":"responses","baseUrl":"https://opencode.ai/inference/openai/v1","contextWindow":922000,"outputLimit":128000,"images":true,"reasoning":true,"price":{"input":30,"output":180,"cacheRead":30}},
    {"id":"console/gpt-5.6-luna","upstreamId":"gpt-5.6-luna","plan":"console","label":"GPT-5.6 Luna","wire":"responses","baseUrl":"https://opencode.ai/inference/openai/v1","contextWindow":922000,"outputLimit":128000,"images":true,"reasoning":true,"price":{"input":0.2,"output":1.2,"cacheRead":0.02}},
    {"id":"console/gpt-5.6-sol","upstreamId":"gpt-5.6-sol","plan":"console","label":"GPT-5.6 Sol","wire":"responses","baseUrl":"https://opencode.ai/inference/openai/v1","contextWindow":922000,"outputLimit":128000,"images":true,"reasoning":true,"price":{"input":4,"output":20,"cacheRead":0.4}},
    {"id":"console/gpt-5.6-terra","upstreamId":"gpt-5.6-terra","plan":"console","label":"GPT-5.6 Terra","wire":"responses","baseUrl":"https://opencode.ai/inference/openai/v1","contextWindow":922000,"outputLimit":128000,"images":true,"reasoning":true,"price":{"input":2,"output":12,"cacheRead":0.2}},
    {"id":"console/gpt-6-astra","upstreamId":"gpt-6-astra","plan":"console","label":"GPT-6 Astra","wire":"responses","baseUrl":"https://opencode.ai/inference/openai/v1","contextWindow":922000,"outputLimit":128000,"images":true,"reasoning":true,"price":{"input":10,"output":50,"cacheRead":1}},
    {"id":"console/gpt-6-luna","upstreamId":"gpt-6-luna","plan":"console","label":"GPT-6 Luna","wire":"responses","baseUrl":"https://opencode.ai/inference/openai/v1","contextWindow":922000,"outputLimit":128000,"images":true,"reasoning":true,"price":{"input":0.1,"output":0.5,"cacheRead":0.01}},
    {"id":"console/gpt-6-sol","upstreamId":"gpt-6-sol","plan":"console","label":"GPT-6 Sol","wire":"responses","baseUrl":"https://opencode.ai/inference/openai/v1","contextWindow":922000,"outputLimit":128000,"images":true,"reasoning":true,"price":{"input":2,"output":10,"cacheRead":0.2}},
    {"id":"console/gpt-6.1-sol","upstreamId":"gpt-6.1-sol","plan":"console","label":"GPT-6.1 Sol","wire":"responses","baseUrl":"https://opencode.ai/inference/openai/v1","contextWindow":922000,"outputLimit":128000,"images":true,"reasoning":true,"price":{"input":2,"output":10,"cacheRead":0.1}},
    {"id":"console/grok-4.5","upstreamId":"grok-4.5","plan":"console","label":"Grok 4.5","wire":"responses","baseUrl":"https://opencode.ai/inference/openai/v1","contextWindow":500000,"outputLimit":500000,"images":true,"reasoning":true,"price":{"input":2,"output":6,"cacheRead":0.3}},
    {"id":"console/grok-4.6","upstreamId":"grok-4.6","plan":"console","label":"Grok 4.6","wire":"responses","baseUrl":"https://opencode.ai/inference/openai/v1","contextWindow":500000,"outputLimit":500000,"images":true,"reasoning":true,"price":{"input":2,"output":6,"cacheRead":0.5}},
    {"id":"console/grok-4.7","upstreamId":"grok-4.7","plan":"console","label":"Grok 4.7","wire":"responses","baseUrl":"https://opencode.ai/inference/openai/v1","contextWindow":500000,"outputLimit":500000,"images":true,"reasoning":true,"price":{"input":2,"output":6,"cacheRead":0.5}},
    {"id":"console/grok-build-0.1","upstreamId":"grok-build-0.1","plan":"console","label":"Grok Build 0.1","wire":"responses","baseUrl":"https://opencode.ai/inference/openai/v1","contextWindow":256000,"outputLimit":256000,"images":true,"reasoning":true,"price":{"input":1,"output":2,"cacheRead":0.2}},
    {"id":"console/kimi-k2.5","upstreamId":"kimi-k2.5","plan":"console","label":"Kimi K2.5","wire":"chat","baseUrl":"https://opencode.ai/inference/openai/v1","contextWindow":262144,"outputLimit":65536,"images":true,"reasoning":true,"price":{"input":0.6,"output":3,"cacheRead":0.1}},
    {"id":"console/kimi-k2.6","upstreamId":"kimi-k2.6","plan":"console","label":"Kimi K2.6","wire":"chat","baseUrl":"https://opencode.ai/inference/openai/v1","contextWindow":262144,"outputLimit":65536,"images":true,"reasoning":true,"price":{"input":0.95,"output":4,"cacheRead":0.16}},
    {"id":"console/kimi-k2.7-code","upstreamId":"kimi-k2.7-code","plan":"console","label":"Kimi K2.7 Code","wire":"chat","baseUrl":"https://opencode.ai/inference/openai/v1","contextWindow":262144,"outputLimit":262144,"images":true,"reasoning":true,"price":{"input":0.95,"output":4,"cacheRead":0.19}},
    {"id":"console/kimi-k3","upstreamId":"kimi-k3","plan":"console","label":"Kimi K3","wire":"chat","baseUrl":"https://opencode.ai/inference/openai/v1","contextWindow":1048576,"outputLimit":131072,"images":true,"reasoning":true,"price":{"input":3,"output":15,"cacheRead":0.3}},
    {"id":"console/minimax-m2.5","upstreamId":"minimax-m2.5","plan":"console","label":"MiniMax-M2.5","wire":"chat","baseUrl":"https://opencode.ai/inference/openai/v1","contextWindow":204800,"outputLimit":131072,"images":false,"reasoning":true,"price":{"input":0.3,"output":1.2,"cacheRead":0.06}},
    {"id":"console/minimax-m2.7","upstreamId":"minimax-m2.7","plan":"console","label":"MiniMax-M2.7","wire":"chat","baseUrl":"https://opencode.ai/inference/openai/v1","contextWindow":204800,"outputLimit":131072,"images":false,"reasoning":true,"price":{"input":0.3,"output":1.2,"cacheRead":0.06}},
    {"id":"console/minimax-m3","upstreamId":"minimax-m3","plan":"console","label":"MiniMax-M3","wire":"chat","baseUrl":"https://opencode.ai/inference/openai/v1","contextWindow":512000,"outputLimit":128000,"images":true,"reasoning":true,"price":{"input":0.3,"output":1.2,"cacheRead":0.06}},
    {"id":"console/mistral-large-4","upstreamId":"mistral-large-4","plan":"console","label":"Mistral Large 4","wire":"chat","baseUrl":"https://opencode.ai/inference/openai/v1","contextWindow":524288,"outputLimit":262144,"images":true,"reasoning":true,"price":{"input":0.68,"output":2.09,"cacheRead":0.07}},
    {"id":"console/muse-ember-1.0","upstreamId":"muse-ember-1.0","plan":"console","label":"Muse Ember 1.0","wire":"responses","baseUrl":"https://opencode.ai/inference/openai/v1","contextWindow":1048576,"outputLimit":270000,"images":true,"reasoning":true,"price":{"input":0.1,"output":0.5,"cacheRead":0.004}},
    {"id":"console/muse-spark-1.2","upstreamId":"muse-spark-1.2","plan":"console","label":"Muse Spark 1.2","wire":"responses","baseUrl":"https://opencode.ai/inference/openai/v1","contextWindow":1048576,"outputLimit":131072,"images":true,"reasoning":true,"price":{"input":1.25,"output":4.25,"cacheRead":0.15}},
    {"id":"console/muse-spark-1.3","upstreamId":"muse-spark-1.3","plan":"console","label":"Muse Spark 1.3","wire":"responses","baseUrl":"https://opencode.ai/inference/openai/v1","contextWindow":1048576,"outputLimit":131072,"images":true,"reasoning":true,"price":{"input":1.25,"output":4.25,"cacheRead":0.15}},
    {"id":"console/muse-wonder-1.0","upstreamId":"muse-wonder-1.0","plan":"console","label":"Muse Wonder","wire":"responses","baseUrl":"https://opencode.ai/inference/openai/v1","contextWindow":1048576,"outputLimit":131072,"images":true,"reasoning":true,"price":{"input":4,"output":20,"cacheRead":0.2}},
    {"id":"console/qwen3.5-plus","upstreamId":"qwen3.5-plus","plan":"console","label":"Qwen3.5 Plus","wire":"anthropic","baseUrl":"https://opencode.ai/inference/anthropic/v1","contextWindow":262144,"outputLimit":65536,"images":true,"reasoning":true,"price":{"input":0.2,"output":1.2,"cacheRead":0.02}},
    {"id":"console/qwen3.6-plus","upstreamId":"qwen3.6-plus","plan":"console","label":"Qwen3.6 Plus","wire":"anthropic","baseUrl":"https://opencode.ai/inference/anthropic/v1","contextWindow":262144,"outputLimit":65536,"images":true,"reasoning":true,"price":{"input":0.5,"output":3,"cacheRead":0.05}},
    {"id":"console/qwen3.8-flash","upstreamId":"qwen3.8-flash","plan":"console","label":"Qwen3.8 Flash","wire":"anthropic","baseUrl":"https://opencode.ai/inference/anthropic/v1","contextWindow":1000000,"outputLimit":131072,"images":true,"reasoning":true,"price":{"input":0.15,"output":0.47,"cacheRead":0.016}},
    {"id":"console/qwen3.8-max","upstreamId":"qwen3.8-max","plan":"console","label":"Qwen3.8 Max","wire":"chat","baseUrl":"https://opencode.ai/inference/openai/v1","contextWindow":262144,"outputLimit":131072,"images":true,"reasoning":true,"price":{"input":2,"output":6,"cacheRead":0.25}},
]

const SNAPSHOT_IDS = new Set(DESKTOP_OPENCODE_SNAPSHOT.map(model => model.id))

export function desktopOpencodeDefaultModelIds(): string[] {
    const go = DESKTOP_OPENCODE_SNAPSHOT.filter(model => model.plan === 'go' && !isFreeDesktopOpencodeModel(model.price)).map(model => model.id)
    return [DESKTOP_OPENCODE_DEFAULT_MODEL, ...go.filter(id => id !== DESKTOP_OPENCODE_DEFAULT_MODEL)]
}

// Null when the value can be stored as an OpenCode key. Anything else is rejected, including a ChatGPT sign-in.
export function desktopOpencodeKeyProblem(value: string): string | null {
    const token = value.trim()
    if (!token) return 'Add an OpenCode API key. It starts with oc_sk_.'
    if (token.startsWith('eyJ')) return 'A ChatGPT sign-in cannot be used as an OpenCode key.'
    if (token.startsWith('sk-ant-')) return 'This is an Anthropic or Claude token. OpenCode uses its own key.'
    if (token.startsWith('sk-or-') || token.startsWith('sk-or-v1')) return 'This is an OpenRouter key. OpenCode is not an OpenRouter endpoint.'
    if (token.startsWith('sk-')) return 'This is an OpenAI key. OpenCode uses a key that starts with oc_sk_.'
    if (!token.startsWith('oc_sk_') || /\s/.test(token)) return 'OpenCode keys start with oc_sk_.'
    return null
}

export const DESKTOP_OPENCODE_CONNECTION_ID = 'opencode-desktop'

const connectionModels = {
    enabledModelIds: z.array(z.string().min(1).max(256)).max(256),
    defaultModelId: z.string().min(1).max(256),
    consoleEnabled: z.boolean(),
}

export const desktopOpencodeConnectionView = z.object({
    workspaceId: desktopWorkspaceIdSchema,
    connectionId: z.literal(DESKTOP_OPENCODE_CONNECTION_ID),
    revision: z.uuid(),
    name: z.string().trim().min(1).max(100),
    ...connectionModels,
})

const changeScope = { workspaceId: desktopWorkspaceIdSchema, expectedRevision: z.uuid() }

export const desktopOpencodeConnectionChange = z.discriminatedUnion('action', [
    z.strictObject({ ...changeScope, action: z.literal('key'), expectedRevision: z.uuid().nullable(), apiKey: z.string().trim().min(1).max(4096) }),
    z.strictObject({ ...changeScope, action: z.literal('models'), ...connectionModels }),
    z.strictObject({ ...changeScope, action: z.literal('rename'), name: desktopOpencodeConnectionView.shape.name }),
    z.strictObject({ ...changeScope, action: z.literal('disconnect') }),
])
export type DesktopOpencodeConnectionChange = z.infer<typeof desktopOpencodeConnectionChange>

export const desktopOpencodeWindowSchema = z.strictObject({
    kind: z.enum(['session', 'weekly', 'monthly']),
    label: z.null(),
    usedPercent: z.number(),
    resetsAt: z.string().nullable(),
})
export type DesktopOpencodeWindow = z.infer<typeof desktopOpencodeWindowSchema>

const usageWindowSchema = z.object({ status: z.string(), percent: z.number(), resetsAt: z.string().nullable().optional() })
const usageSchema = z.object({
    usage: z.object({ rolling: usageWindowSchema.optional(), weekly: usageWindowSchema.optional(), monthly: usageWindowSchema.optional() }),
})

const USAGE_WINDOWS = [['rolling', 'session'], ['weekly', 'weekly'], ['monthly', 'monthly']] as const

// A non-ok status is spent even when the percentage is under 100. An unknown body is no reading, not a refused key.
export function desktopOpencodeWindows(body: unknown): DesktopOpencodeWindow[] {
    const parsed = usageSchema.safeParse(body)
    if (!parsed.success) return []
    return USAGE_WINDOWS.flatMap(([field, kind]) => {
        const window = parsed.data.usage[field]
        if (!window) return []
        const usedPercent = window.status === 'ok' ? window.percent : Math.max(window.percent, 100)
        return [{ kind, label: null, usedPercent, resetsAt: window.resetsAt ?? null }]
    })
}

export const desktopOpencodeRefreshSchema = z.strictObject({
    workspaceId: desktopWorkspaceIdSchema,
    requestId: z.string().min(1).max(200),
    revision: z.string().min(1).max(200),
    source: z.enum(['live', 'cached', 'snapshot']),
    fresh: z.boolean(),
    capturedAt: z.string().nullable(),
    unavailableReason: z.string().max(500).optional(),
    selectedModelId: z.string().min(1).max(300),
    selectedPreserved: z.boolean(),
    retiredModelIds: z.array(z.string()),
    models: z.array(desktopOpencodeModelSchema),
})
export type DesktopOpencodeRefresh = z.infer<typeof desktopOpencodeRefreshSchema>

export const DESKTOP_OPENCODE_PLAN_DESCRIPTION = { go: 'Included in Go', console: 'Console credits' } as const

export const desktopOpencodeModelRowSchema = z.strictObject({
    id: z.string(),
    label: z.string(),
    plan: z.enum(DESKTOP_OPENCODE_PLANS),
    description: z.enum(['Included in Go', 'Console credits', 'Free']),
    enabled: z.boolean(),
    locked: z.boolean(),
    lockReason: z.string().optional(),
    retired: z.boolean(),
    isNew: z.boolean(),
    price: desktopOpencodeModelSchema.shape.price.nullable(),
})
export type DesktopOpencodeModelRow = z.infer<typeof desktopOpencodeModelRowSchema>

export function desktopOpencodeModelRows(input: {
    models: readonly DesktopOpencodeModel[]
    source: 'live' | 'cached' | 'snapshot'
    enabledModelIds: readonly string[]
    consoleEnabled: boolean
}): DesktopOpencodeModelRow[] {
    const listed = new Set(input.models.map(model => model.id))
    const enabled = new Set(input.enabledModelIds)
    const retiredIds = input.source === 'live' ? input.enabledModelIds.filter(id => desktopOpencodePlanOf(id) && !listed.has(id)) : []
    const rows = [
        ...input.models.map(model => ({ model, retired: false, id: model.id })),
        ...retiredIds.map(id => ({ model: null as DesktopOpencodeModel | null, retired: true, id })),
    ]
    return rows
        .map(row => {
            const id = row.id
            const plan = row.model?.plan ?? desktopOpencodePlanOf(id)!
            const consoleLocked = plan === 'console' && !input.consoleEnabled
            return {
                id,
                label: row.model?.label ?? id,
                plan,
                description: row.model && isFreeDesktopOpencodeModel(row.model.price)
                    ? 'Free' as const : DESKTOP_OPENCODE_PLAN_DESCRIPTION[plan],
                enabled: enabled.has(id),
                locked: consoleLocked,
                lockReason: consoleLocked ? 'Off until you switch Console on.' : undefined,
                retired: row.retired,
                isNew: !SNAPSHOT_IDS.has(id),
                price: row.model?.price ?? null,
            }
        })
        .sort((a, b) => Number(a.plan === 'console') - Number(b.plan === 'console') || a.id.localeCompare(b.id))
}

export function desktopOpencodeEnableProblem(input: {
    enabledModelIds: readonly string[]
    defaultModelId: string
    consoleEnabled: boolean
    knownIds: readonly string[]
}): string | null {
    const known = new Set(input.knownIds)
    if (!input.enabledModelIds.length) return 'Keep at least one OpenCode model available.'
    if (!input.enabledModelIds.includes(input.defaultModelId)) return 'Choose another default before removing this model.'
    for (const id of input.enabledModelIds) {
        const plan = desktopOpencodePlanOf(id)
        if (!plan || !known.has(id)) return 'Choose a model OpenCode still lists.'
        if (plan === 'console' && !input.consoleEnabled) return 'Console stays off until you switch it on.'
    }
    if (desktopOpencodePlanOf(input.defaultModelId) === 'console' && !input.consoleEnabled) return 'Console stays off until you switch it on.'
    return null
}

export const desktopOpencodeDispatchSchema = z.strictObject({
    workspaceId: desktopWorkspaceIdSchema,
    connectionId: z.string().min(1).max(200),
    connectionRevision: z.string().min(1).max(200),
    consoleEnabled: z.boolean(),
    modelId: z.string().min(1).max(300),
    purpose: z.enum(['chat', 'foreman', 'auxiliary']),
    runId: z.string().min(1).max(200),
    requestId: z.string().min(1).max(200),
    sessionId: z.string().min(1).max(200),
    stream: z.boolean(),
})
export type DesktopOpencodeDispatch = z.infer<typeof desktopOpencodeDispatchSchema>

export const desktopOpencodeResultSchema = z.strictObject({
    status: z.enum(['saved', 'partial', 'unknown', 'refused']),
    message: z.string().min(1).max(500),
    code: z.enum(['credential', 'retired', 'console', 'workspace', 'replaced', 'cancelled', 'transport', 'limit', 'credits', 'grant', 'unavailable']).optional(),
    sent: z.boolean(),
    text: z.string().max(100_000).optional(),
    billingSource: z.string().max(40).optional(),
    cost: z.number().nonnegative().optional(),
})
export type DesktopOpencodeResult = z.infer<typeof desktopOpencodeResultSchema>

export type DesktopOpencodeBehaviour = 'anthropic' | 'openai' | 'openrouter' | 'google'
const BEHAVIOUR_OF_WIRE: Record<DesktopOpencodeWire, DesktopOpencodeBehaviour> = {
    anthropic: 'anthropic',
    responses: 'openai',
    chat: 'openrouter',
    google: 'google',
}

export function desktopOpencodeBehaviour(model: DesktopOpencodeModel | undefined): DesktopOpencodeBehaviour | undefined {
    return model ? BEHAVIOUR_OF_WIRE[model.wire] : undefined
}

// Automatic vision only considers enabled paid Go models. The selected-model path is separate.
export function desktopOpencodeVisionModel(enabled: readonly DesktopOpencodeModel[]): string | null {
    const seeing = enabled.filter(model => model.images && model.plan === 'go' && !isFreeDesktopOpencodeModel(model.price))
        .sort((a, b) => a.price.input + a.price.output - (b.price.input + b.price.output))
    return seeing[0]?.id ?? null
}

const catalogScope = { workspaceId: desktopWorkspaceIdSchema, requestId: z.string().min(1).max(200), selectedModelId: z.string().min(1).max(256) }
export const desktopOpencodeSettingsRequest = z.union([
    desktopOpencodeConnectionChange,
    z.strictObject({ ...catalogScope, action: z.literal('catalog') }),
    z.strictObject({ ...catalogScope, action: z.literal('refresh') }),
    z.strictObject({ workspaceId: desktopWorkspaceIdSchema, action: z.literal('usage'), refresh: z.boolean().optional() }),
])
export const desktopOpencodeUsageView = z.object({
    windows: z.array(desktopOpencodeWindowSchema),
    capturedAt: z.string().nullable(),
    fresh: z.boolean(),
})

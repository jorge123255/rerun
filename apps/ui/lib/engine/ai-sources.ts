import { rerunCreditTotalMicros, type RerunCreditColumns } from '@/cloud/billing'
import { catalogFor, modelLabel, modelPower, type CatalogModel } from '@/lib/engine/models'
import type { BoxConnection, BoxDefault } from '@/lib/engine/types'
import { shortUntil } from '@/lib/time'
import { PROVIDER_LABELS, RERUN_CONNECTION_ID, RERUN_MODEL, RERUN_MODELS, RERUN_TIERS, canonicalModelId, isPremiumModel, type DesktopSubscriptionProvider, type PlanLimitWindow, type Provider, type RerunTier } from '@rerun/contracts'

// The AI providers dialog sorts every connection by who pays for it: the credit included with
// Rerun, the user's own subscription, or the user's own API key.
export type SourceKind = 'included' | 'plan' | 'key'

export type AddableProvider = Exclude<Provider, 'rerun' | 'custom' | DesktopSubscriptionProvider>

export type KeyProvider = Exclude<AddableProvider, 'claude' | 'codex'>

export function sourceKind(provider: string): SourceKind {
    const section = catalogFor(provider).section
    return section === 'free' ? 'included' : section === 'subscription' ? 'plan' : 'key'
}

export const KIND_LABEL: Record<SourceKind, string> = { included: 'Included', plan: 'Plan', key: 'API key' }

export const PROVIDER_PITCH: Record<AddableProvider, { title: string; hint: string }> = {
    claude: { title: 'Claude Pro or Max', hint: 'Sign in with your Claude account' },
    codex: { title: 'ChatGPT Plus or Pro', hint: 'Sign in with your ChatGPT account' },
    anthropic: { title: 'Anthropic', hint: 'Claude models, billed per token' },
    openai: { title: 'OpenAI', hint: 'GPT models, billed per token' },
    google: { title: 'Google', hint: 'Gemini models, billed per token' },
    openrouter: { title: 'OpenRouter', hint: 'Every model behind one key' },
}

// Numbered steps rendered by CredentialGuide, the same fold the service credentials use.
export const PROVIDER_GUIDE: Record<KeyProvider, { title: string; steps: string }> = {
    anthropic: {
        title: 'How to get your Anthropic key',
        steps: [
            '1. Open the [Anthropic Console](https://console.anthropic.com/settings/keys) and sign in.',
            '2. Click **Create Key** and name it, for example "Rerun".',
            '3. Copy the key (it starts with `sk-ant-`) and paste it above. It is shown only once.',
        ].join('\n'),
    },
    openai: {
        title: 'How to get your OpenAI key',
        steps: [
            '1. Open [OpenAI API keys](https://platform.openai.com/api-keys) and sign in.',
            '2. Click **Create new secret key** and name it, for example "Rerun".',
            '3. Copy the key (it starts with `sk-`) and paste it above. It is shown only once.',
        ].join('\n'),
    },
    google: {
        title: 'How to get your Google key',
        steps: [
            '1. Open [Google AI Studio](https://aistudio.google.com/apikey) and sign in with your Google account.',
            '2. Click **Create API key** and pick a Google Cloud project.',
            '3. Copy the key and paste it above.',
        ].join('\n'),
    },
    openrouter: {
        title: 'How to get your OpenRouter key',
        steps: [
            '1. Open [OpenRouter keys](https://openrouter.ai/keys) and sign in.',
            '2. Click **Create API Key**, and add credits if your balance is empty.',
            '3. Copy the key (it starts with `sk-or-`) and paste it above. It is shown only once.',
        ].join('\n'),
    },
}

export const PLAN_PROVIDERS: AddableProvider[] = ['claude', 'codex']
export const KEY_PROVIDERS: KeyProvider[] = ['anthropic', 'openai', 'google', 'openrouter']

export const PLAN_LABELS: Partial<Record<AddableProvider, string>> = { claude: 'Claude Code', codex: 'Codex' }

const PLAN_NAMES: Partial<Record<Provider, string>> = { claude: 'Claude', codex: 'ChatGPT' }

export const RERUN_FALLBACK: BoxDefault = { connectionId: RERUN_CONNECTION_ID, model: RERUN_MODEL }

// What agents with no model of their own run on: a fresh workspace has no default, and runs on Rerun.
export function effectiveDefault(boxDefault: BoxDefault | null): BoxDefault {
    return boxDefault ?? RERUN_FALLBACK
}

// `paused`: a member turned the credit off, and the hub refuses every Rerun call until it is resumed.
export type RerunCredit = { usedMicros: number; budgetMicros: number; resetAt: string | null; percent: number; paused?: boolean }

export function rerunCreditOf(workspace: (RerunCreditColumns & { current_period_end?: string | null; rerun_credit_paused_at?: string | null }) | null | undefined): RerunCredit {
    const usedMicros = workspace?.rerun_used_micros ?? 0
    const budgetMicros = rerunCreditTotalMicros(workspace)
    const percent = budgetMicros > 0 ? Math.min(100, Math.round((usedMicros / budgetMicros) * 100)) : 0
    return { usedMicros, budgetMicros, resetAt: workspace?.current_period_end ?? null, percent, paused: !!workspace?.rerun_credit_paused_at }
}

export const RERUN_CREDIT_PAUSED_REASON = 'Rerun credits are paused'

export function isCreditUsedUp(credit: RerunCredit) {
    return credit.budgetMicros > 0 && credit.usedMicros >= credit.budgetMicros
}

export function creditResetPhrase(credit: RerunCredit) {
    return credit.resetAt ? `on ${new Date(credit.resetAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}` : 'next month'
}

// Rerun offers Balanced alone for now, shown as "Rerun". The boxes still list Fast and Smart and the
// hub still serves them, so what is already pinned on one keeps running: only the pickers drop them.
const HIDDEN_RERUN_MODELS = new Set<string>([RERUN_MODELS.fast, RERUN_MODELS.smart])

export function isHiddenModel(connectionId: string, model: string): boolean {
    return connectionId === RERUN_CONNECTION_ID && HIDDEN_RERUN_MODELS.has(model)
}

// Extra ids are served on top of `models` by the engine, so they are always on.
export function offeredModels(source: BoxConnection): CatalogModel[] {
    const catalog = catalogFor(source.provider).models
    const catalogIds = new Set(catalog.map(m => m.id))
    // A model the connection still offers that the catalog no longer lists (retired between two
    // deploys) has to stay switchable off.
    const orphans = source.models.filter(id => !catalogIds.has(id))
    const extras = source.extraModels.filter(id => !catalogIds.has(id) && !orphans.includes(id))
    const offered = [...catalog, ...[...orphans, ...extras].map(id => ({ id, label: modelLabel(id), power: modelPower(id) }))]
    return inTierOrder(source.id, offered.filter(m => !isHiddenModel(source.id, m.id)))
}

export function isModelEnabled(source: BoxConnection, modelId: string) {
    return source.models.includes(modelId) || source.extraModels.includes(modelId)
}

export function enabledModels(source: BoxConnection): CatalogModel[] {
    return offeredModels(source).filter(m => isModelEnabled(source, m.id))
}

// Balanced is labelled "Rerun" already; only a tier pinned before the others were hidden needs the prefix.
export function modelName(connectionId: string, model: string) {
    return connectionId === RERUN_CONNECTION_ID && canonicalModelId(model) !== RERUN_MODEL ? `Rerun ${modelLabel(model)}` : modelLabel(model)
}

// Before paying, the hub serves Balanced for Smart and the box steps Opus, Fable and Astra down, so
// a picker that let them through would name a model the run does not get. A locked row opens the
// plan instead.
export function isModelLocked(connectionId: string, model: string, premiumAllowed: boolean): boolean {
    if (premiumAllowed) return false
    return (connectionId === RERUN_CONNECTION_ID && model === RERUN_MODELS.smart) || isPremiumModel(model)
}

// What the billing dialog is told opened it, for the funnel.
export const PREMIUM_MODEL_BILLING_TRIGGER = 'premium_model'

// None for Balanced: alone in its list, it reads as a plain "Rerun" row.
const RERUN_TIER_DESCRIPTION: Partial<Record<RerunTier, string>> = {
    fast: 'Quick and cheap',
    smart: 'The smartest',
}

// The hint beside a Rerun tier's name. Nothing for any other model: only the tiers get one, a
// provider's own list is too long for it.
export function rerunTierDescription(connectionId: string, model: string): string | undefined {
    if (connectionId !== RERUN_CONNECTION_ID) return undefined
    const id = canonicalModelId(model)
    const tier = RERUN_TIERS.find(candidate => RERUN_MODELS[candidate] === id)
    return tier && RERUN_TIER_DESCRIPTION[tier]
}

// Fast, Balanced, Smart, whatever order the box stores them in: its own list starts with Balanced,
// because the first entry is what the connection runs when no model is named.
export function inTierOrder<T extends { id: string }>(connectionId: string, models: T[]): T[] {
    if (connectionId !== RERUN_CONNECTION_ID) return models
    const rank = (id: string) => {
        const at = RERUN_TIERS.findIndex(tier => RERUN_MODELS[tier] === id)
        return at === -1 ? RERUN_TIERS.length : at
    }
    return [...models].sort((a, b) => rank(a.id) - rank(b.id))
}

export function isCreditExhausted(source: BoxConnection, credit: RerunCredit) {
    return source.id === RERUN_CONNECTION_ID && isCreditUsedUp(credit)
}

export function isRerunPaused(source: BoxConnection, credit: RerunCredit) {
    return source.id === RERUN_CONNECTION_ID && !!credit.paused
}

export function isUsable(source: BoxConnection, credit: RerunCredit) {
    return source.connected && !source.credentialRejected && !isCreditExhausted(source, credit) && !isRerunPaused(source, credit)
}

// Where a subscription stands against its plan, as of now rather than as of the reading: a window
// whose reset has passed since then starts over empty, and its next reset is not known yet.
export function livePlanWindows(source: Pick<BoxConnection, 'planLimits'>, now = Date.now()): PlanLimitWindow[] {
    return (source.planLimits?.windows ?? []).map(window => (window.resetsAt && Date.parse(window.resetsAt) <= now ? { ...window, usedPercent: 0, resetsAt: null } : window))
}

// The window that runs out first is the one a single gauge has to show.
export function tightestPlanWindow(windows: PlanLimitWindow[]): PlanLimitWindow | null {
    return windows.reduce<PlanLimitWindow | null>((tightest, window) => (!tightest || window.usedPercent > tightest.usedPercent ? window : tightest), null)
}

export type PlanLimitTone = 'brand' | 'warning' | 'destructive'

export function planLimitTone(usedPercent: number): PlanLimitTone {
    if (usedPercent >= 90) return 'destructive'
    if (usedPercent >= 75) return 'warning'
    return 'brand'
}

export function planWindowName(window: PlanLimitWindow): string {
    if (window.kind === 'session') return 'Session'
    if (window.kind === 'weekly') return 'Weekly'
    return window.label ? `${window.label} weekly` : 'Model weekly'
}

export function planWindowPercent(window: PlanLimitWindow): string {
    return `${Math.round(window.usedPercent)}%`
}

export function planWindowReset(window: PlanLimitWindow): string | null {
    return window.resetsAt ? `resets ${shortUntil(window.resetsAt)}` : null
}

export function sourceSummary(source: BoxConnection, credit: RerunCredit): string {
    if (source.id === RERUN_CONNECTION_ID && credit.paused) return RERUN_CREDIT_PAUSED_REASON
    if (source.id === RERUN_CONNECTION_ID) return isCreditUsedUp(credit) ? `Monthly credits used up, back ${creditResetPhrase(credit)}` : `${credit.percent}% of this month's credits used`
    const planWindows = livePlanWindows(source).filter(window => window.kind !== 'model')
    if (planWindows.length) return planWindows.map(window => `${planWindowName(window)} ${planWindowPercent(window)}`).join(' · ')
    const count = enabledModels(source).length
    const models = count === 1 ? '1 model' : `${count} models`
    return `${KIND_LABEL[sourceKind(source.provider)]} · ${models}`
}

// "Claude", then "Claude 2": a name is what tells two subscriptions of the same provider apart in
// every model picker, so it must never come out identical to one already there.
export function suggestName(provider: Provider, taken: string[]): string {
    const base = PLAN_NAMES[provider] ?? PROVIDER_LABELS[provider]
    if (!taken.includes(base)) return base
    for (let n = 2; ; n += 1) {
        const candidate = `${base} ${n}`
        if (!taken.includes(candidate)) return candidate
    }
}

import type { ConnectionSummary, PlanLimits } from './connection.js'

/**
 * Rerun Fast, Balanced and Smart in the Mac app.
 *
 * On Rerun Cloud each name is served by one model through Rerun's own key and credits. The Mac has
 * no such key, so a name is a ranked list instead: the first entry that the owner is signed in to,
 * that offers the model, and that still has usage left answers the message. The first entry of
 * each list is the model Rerun Cloud serves that name with, reached through the owner's own plan.
 *
 * Nothing here is stored as a model. A preset is resolved to a real connection and model each time
 * a message is sent, so the engine only ever sees a pair it already knows how to run.
 */
export const DESKTOP_PRESET_CONNECTION_ID = 'rerun-presets'
export const DESKTOP_PRESET_TIERS = ['fast', 'balanced', 'smart'] as const
export type DesktopPresetTier = (typeof DESKTOP_PRESET_TIERS)[number]
export const DESKTOP_PRESET_LABELS: Record<DesktopPresetTier, string> = { fast: 'Rerun Fast', balanced: 'Rerun Balanced', smart: 'Rerun Smart' }

export function desktopPresetTier(pick: { connectionId: string; model: string } | null | undefined): DesktopPresetTier | null {
    if (pick?.connectionId !== DESKTOP_PRESET_CONNECTION_ID) return null
    return (DESKTOP_PRESET_TIERS as readonly string[]).includes(pick.model) ? pick.model as DesktopPresetTier : null
}

type Candidate = { provider: string; models: readonly string[] }

// A plan the owner already pays for by the month. These are tried first, in order.
const PLANS: Record<DesktopPresetTier, readonly Candidate[]> = {
    fast: [
        { provider: 'codex', models: ['gpt-6-luna', 'gpt-5.6-luna'] },
        { provider: 'claude', models: ['claude-haiku-5-5', 'claude-haiku-4-5'] },
    ],
    balanced: [
        { provider: 'claude', models: ['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-haiku-4-5'] },
        { provider: 'codex', models: ['gpt-6.1-terra', 'gpt-5.6-terra', 'gpt-6-luna', 'gpt-5.6-luna'] },
    ],
    smart: [
        { provider: 'codex', models: ['gpt-6-sol', 'gpt-6.1-sol', 'gpt-5.6-sol'] },
        { provider: 'claude', models: ['claude-opus-5-5', 'claude-fable-5-2', 'claude-opus-5', 'claude-sonnet-5-5'] },
    ],
}

// Keys billed per token. Used only when no plan above is connected at all, so a preset never moves
// from a plan that ran out to a key that costs money without the owner choosing that.
const KEYS: Record<DesktopPresetTier, readonly Candidate[]> = {
    fast: [
        { provider: 'openai', models: ['gpt-6-luna', 'gpt-5.6-luna'] },
        { provider: 'openrouter', models: ['openai/gpt-6-luna', 'anthropic/claude-haiku-5.5'] },
        { provider: 'anthropic', models: ['claude-haiku-5-5', 'claude-haiku-4-5'] },
    ],
    balanced: [
        { provider: 'anthropic', models: ['claude-haiku-5-5', 'claude-sonnet-5-5'] },
        { provider: 'openrouter', models: ['anthropic/claude-haiku-5.5', 'openai/gpt-6-luna'] },
        { provider: 'openai', models: ['gpt-6.1-terra', 'gpt-6-luna'] },
    ],
    smart: [
        { provider: 'openai', models: ['gpt-6-sol', 'gpt-6.1-sol'] },
        { provider: 'openrouter', models: ['openai/gpt-6-sol'] },
        { provider: 'anthropic', models: ['claude-opus-5-5', 'claude-sonnet-5-5'] },
    ],
}

type PresetConnection = Pick<ConnectionSummary, 'id' | 'name' | 'provider' | 'connected' | 'models' | 'extraModels'> & Partial<Pick<ConnectionSummary, 'credentialRejected' | 'planLimits'>>

/** A plan is out of usage when its session or weekly window is full and has not reset yet. */
export function desktopPlanExhausted(limits: PlanLimits | null | undefined, now: Date): boolean {
    return !!limits?.windows.some(window => window.kind !== 'model' && window.usedPercent >= 100
        && (window.resetsAt === null || Date.parse(window.resetsAt) > now.getTime()))
}

export type DesktopPresetSkip = { name: string; reason: 'not-connected' | 'no-model' | 'out-of-usage' }
export type DesktopPresetResolution = {
    tier: DesktopPresetTier
    connectionId: string
    provider: string
    name: string
    model: string
    /** False when an earlier entry of the list was passed over; `skipped` says which and why. */
    preferred: boolean
    skipped: DesktopPresetSkip[]
}

function walk(tier: DesktopPresetTier, list: readonly Candidate[], connections: readonly PresetConnection[], now: Date, skipped: DesktopPresetSkip[]): DesktopPresetResolution | null {
    for (const candidate of list) {
        const connection = connections.find(item => item.provider === candidate.provider)
        const name = connection?.name ?? candidate.provider
        if (!connection?.connected || connection.credentialRejected) { skipped.push({ name, reason: 'not-connected' }); continue }
        const offered = [...connection.models, ...(connection.extraModels ?? [])]
        const model = candidate.models.find(id => offered.includes(id))
        if (!model) { skipped.push({ name, reason: 'no-model' }); continue }
        if (desktopPlanExhausted(connection.planLimits, now)) { skipped.push({ name, reason: 'out-of-usage' }); continue }
        return { tier, connectionId: connection.id, provider: connection.provider, name: connection.name, model, preferred: skipped.length === 0, skipped }
    }
    return null
}

/** The connection and model that answer this preset now, or null when nothing on its list can. */
export function resolveDesktopPreset(tier: DesktopPresetTier, connections: readonly PresetConnection[], now: Date = new Date()): DesktopPresetResolution | null {
    const skipped: DesktopPresetSkip[] = []
    const plan = walk(tier, PLANS[tier], connections, now, skipped)
    if (plan) return plan
    // A connected plan that ran out is not replaced by a paid key.
    const hasPlan = PLANS[tier].some(candidate => connections.some(item => item.provider === candidate.provider && item.connected && !item.credentialRejected))
    return hasPlan ? null : walk(tier, KEYS[tier], connections, now, skipped)
}

/** Why a preset has nothing to run on, in words for the person choosing it. */
export function desktopPresetUnavailable(tier: DesktopPresetTier, connections: readonly PresetConnection[], now: Date = new Date()): string {
    const skipped: DesktopPresetSkip[] = []
    walk(tier, PLANS[tier], connections, now, skipped)
    const out = skipped.filter(item => item.reason === 'out-of-usage').map(item => item.name)
    if (out.length) return `${DESKTOP_PRESET_LABELS[tier]} has no plan with usage left (${out.join(', ')}). Choose a model yourself, or wait for the limit to reset.`
    return `${DESKTOP_PRESET_LABELS[tier]} needs a ChatGPT or Claude plan, or an OpenAI, Anthropic or OpenRouter key. Connect one in Settings.`
}

/**
 * One line for the person when a preset is not on its first choice: what is answering, and why the
 * first choice is not. Null when the preset is on its first choice, which needs no saying.
 */
export function desktopPresetFallbackNote(found: DesktopPresetResolution | null, modelLabel: string): string | null {
    if (!found || found.preferred) return null
    const first = found.skipped[0]
    const why = !first ? '' : first.reason === 'out-of-usage' ? `${first.name} is out of usage`
        : first.reason === 'not-connected' ? `${first.name} is not connected` : `${first.name} does not offer its model`
    return `${DESKTOP_PRESET_LABELS[found.tier]} is answering on ${found.name} · ${modelLabel}${why ? `: ${why}.` : '.'}`
}

/** The note travels in a response header, which takes plain ASCII only. */
export const DESKTOP_PRESET_NOTE_HEADER = 'x-rerun-preset-note'

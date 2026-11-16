import type { ConnectionSummary, PlanLimits } from './connection.js'
import { desktopPlanExhausted } from './desktop-model-presets.js'

/**
 * When a monthly plan runs out, work waits for it and resumes instead of failing (Mac app).
 *
 * The rules live here so the engine (routines) and the app (chat, settings) decide the same way.
 * Nothing here moves work to a key billed per token: the only other model work may run on is the
 * backup the owner picked in Settings.
 */
export const DESKTOP_USAGE_RECHECK_MS = 15 * 60_000
export const DESKTOP_USAGE_MAX_WAIT_MS = 24 * 60 * 60_000
/** A reset time is the provider's clock, not ours: wait a little past it before trying. */
export const DESKTOP_USAGE_RESET_MARGIN_MS = 30_000

const PLAN_PROVIDERS = ['codex', 'claude', 'grok-build', 'kimi-code', 'devin'] as const
/** A sign-in paid by the month, as opposed to a key billed per token or a model on this Mac. */
export function isDesktopPlanProvider(provider: string | null | undefined): boolean {
    return (PLAN_PROVIDERS as readonly string[]).includes(provider ?? '')
}

export type DesktopPlanWait = {
    /**
     * `waiting`: a window is full and its reset is still ahead, so a run now is certain to be refused.
     * `unknown`: a window read full but carries no reset time, so only trying can tell.
     */
    state: 'ok' | 'waiting' | 'unknown'
    /** When every full window will have reset. Null when none says. */
    resetsAt: string | null
}

export function desktopPlanWait(limits: PlanLimits | null | undefined, now: Date): DesktopPlanWait {
    const full = (limits?.windows ?? []).filter(window => window.kind !== 'model' && window.usedPercent >= 100)
    const ahead = full.map(window => window.resetsAt === null ? NaN : Date.parse(window.resetsAt)).filter(time => time > now.getTime())
    if (ahead.length) return { state: 'waiting', resetsAt: new Date(Math.max(...ahead)).toISOString() }
    return { state: full.some(window => window.resetsAt === null) ? 'unknown' : 'ok', resetsAt: null }
}

export type DesktopUsageParking = {
    /** When the work first started waiting. Kept across re-checks. */
    parkedAt: string
    resetsAt: string | null
    nextCheckAt: string
    /** Set while no reset time is known: the start of the 24 hours of 15-minute checks. */
    recheckSince: string | null
}

/**
 * When to look again. With a reset time ahead, at that time. Without one, every 15 minutes for at
 * most 24 hours; after that the answer is `expired` and the caller records the work as skipped.
 */
export function desktopUsagePark(now: Date, resetsAt: string | null, prior?: DesktopUsageParking | null): DesktopUsageParking | 'expired' {
    const parkedAt = prior?.parkedAt ?? now.toISOString()
    const reset = resetsAt === null ? NaN : Date.parse(resetsAt)
    if (reset > now.getTime()) return { parkedAt, resetsAt: new Date(reset).toISOString(), nextCheckAt: new Date(reset + DESKTOP_USAGE_RESET_MARGIN_MS).toISOString(), recheckSince: null }
    const recheckSince = prior?.recheckSince ?? now.toISOString()
    if (now.getTime() - Date.parse(recheckSince) >= DESKTOP_USAGE_MAX_WAIT_MS) return 'expired'
    return { parkedAt, resetsAt: null, nextCheckAt: new Date(now.getTime() + DESKTOP_USAGE_RECHECK_MS).toISOString(), recheckSince }
}

const clock = (iso: string) => {
    const time = new Date(iso)
    return Number.isNaN(time.getTime()) ? iso : time.toLocaleString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit' })
}

/** "Waiting for ChatGPT to reset at Mon 3:00 PM", or the 15-minute wording when no time is known. */
export function desktopUsageWaitText(plan: string, resetsAt: string | null, format: (iso: string) => string = clock): string {
    return resetsAt ? `Waiting for ${plan} to reset at ${format(resetsAt)}` : `Waiting for ${plan} to have usage again (checking every 15 minutes)`
}

export function desktopUsageExpiredText(plan: string): string {
    return `Skipped: ${plan} was still out of usage after 24 hours.`
}

export const DESKTOP_USAGE_STILL_WAITING = 'Skipped: still waiting for the earlier run of this routine.'

/** What a chat send is refused with before it starts. Worded so the chat reads it as a usage limit. */
export function desktopPlanOutMessage(plan: string, resetsAt: string | null, format: (iso: string) => string = clock): string {
    return `${plan} usage limit reached.${resetsAt ? ` It resets at ${format(resetsAt)}.` : ''}`
}

export type DesktopBackupModel = { connectionId: string; model: string }
type BackupConnection = Pick<ConnectionSummary, 'id' | 'name' | 'provider' | 'connected' | 'models' | 'extraModels'> & Partial<Pick<ConnectionSummary, 'credentialRejected' | 'planLimits'>>

/**
 * The backup model, when work that is out of usage may run on it now. Only ever the exact pair the
 * owner saved: a plan with usage left, or a key or local model the owner chose knowing it is paid
 * per token. Never a key picked on the owner's behalf.
 */
export function desktopBackupPick(backup: DesktopBackupModel | null | undefined, connections: readonly BackupConnection[], outConnectionId: string | null, now: Date = new Date()): (DesktopBackupModel & { name: string; provider: string }) | null {
    if (!backup || backup.connectionId === outConnectionId) return null
    const connection = connections.find(item => item.id === backup.connectionId)
    if (!connection?.connected || connection.credentialRejected) return null
    if (![...connection.models, ...(connection.extraModels ?? [])].includes(backup.model)) return null
    if (isDesktopPlanProvider(connection.provider) && desktopPlanExhausted(connection.planLimits, now)) return null
    return { connectionId: connection.id, model: backup.model, name: connection.name, provider: connection.provider }
}

/** The same shape of note the presets use, so the person reads one wording for both. */
export function desktopBackupNote(backupName: string, modelLabel: string, outName: string): string {
    return `Backup model is answering on ${backupName} · ${modelLabel}: ${outName} is out of usage.`
}

/** One parked routine, as the routines list shows it. */
export type DesktopRoutineUsageWait = { slug: string; plan: string; parkedAt: string; resetsAt: string | null; nextCheckAt: string; skippedWhileWaiting: number }
export type DesktopRoutineUsageSkip = { slug: string; at: string; reason: string }

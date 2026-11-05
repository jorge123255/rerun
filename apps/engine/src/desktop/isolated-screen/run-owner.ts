import type { RunContext } from '../../runtime/context.js'

/** Process-local authority from actual screen dispatch; never restored from transcript text. */
export const screenOwners = new Map<string, RunContext>()
const uses = new WeakMap<RunContext, { kind: 'browser' | 'computer'; site: string | null }>()
export function recordScreenUse(ctx: RunContext, kind: 'browser' | 'computer', url?: string) {
    let site = uses.get(ctx)?.site ?? null
    if (url) { try { site = new URL(url).hostname.replace(/^www\./i, '') } catch { site = null } }
    uses.set(ctx, { kind, site })
}
export function currentScreenRun(id: string) {
    const ctx = screenOwners.get(id), screen = ctx && uses.get(ctx)
    if (!ctx || !screen || !ctx.runId || ctx.abortSignal?.aborted) return null
    return { sessionId: ctx.sessionId, runId: ctx.runId, ...screen }
}

import { desktopApp } from '../desktop/policy.js'

type RunHandle = { controller: AbortController; cancel?: () => void | Promise<unknown> }

const controllers = new Map<string, RunHandle>()
const cancellations = new Set<Promise<unknown>>()
const desktopCancellations = new Map<string, Promise<boolean>>()

// One live run per conversation. Two runs on the same session read the same history before
// either has written its user message, so they answer past each other and interleave their
// messages into one transcript. Claimed synchronously, before the run row is even inserted,
// so a duplicate request cannot slip through the await.
type SessionClaim = { runId: string; claimedAt: number; authorId?: string }

const sessionClaims = new Map<string, SessionClaim>()
const claimedSessions = new Map<string, string>()

export function registerRunAbort(runId: string): AbortController {
    const controller = new AbortController()
    controllers.set(runId, { controller })
    return controller
}

// The abort signal alone is not enough to stop a hung run: the codex provider ignores it until its
// turn has actually started, which is exactly the case when an expired token wedges the handshake.
// The run loop registers here what it takes to really close itself down.
export function setRunCancel(runId: string, cancel: () => void | Promise<unknown>): void {
    const handle = controllers.get(runId)
    if (handle) handle.cancel = cancel
}

export function unregisterRunAbort(runId: string): void {
    controllers.delete(runId)
    releaseSession(runId)
}

export function claimSession(sessionId: string, runId: string, authorId?: string): string | null {
    const holder = sessionClaims.get(sessionId)
    if (holder) return holder.runId
    sessionClaims.set(sessionId, { runId, claimedAt: Date.now(), authorId })
    claimedSessions.set(runId, sessionId)
    return null
}

export function sessionClaim(sessionId: string): SessionClaim | null {
    return sessionClaims.get(sessionId) ?? null
}

export function releaseSession(runId: string): void {
    const sessionId = claimedSessions.get(runId)
    if (!sessionId) return
    claimedSessions.delete(runId)
    if (sessionClaims.get(sessionId)?.runId === runId) sessionClaims.delete(sessionId)
}

export function activeRunCount(): number {
    return controllers.size
}

export function sessionClaimCount(): number {
    return sessionClaims.size
}

export function abortRun(runId: string): boolean {
    const handle = controllers.get(runId)
    if (!handle) return false
    controllers.delete(runId)
    const waitForSettlement = desktopApp() && !!handle.cancel
    if (!waitForSettlement) releaseSession(runId)
    handle.controller.abort()
    // Closes the run for good: writes its terminal row, tells the hub, and tears the provider
    // process down. Without it a provider that ignores the abort keeps the conversation "working".
    let pending: Promise<unknown>
    try { pending = Promise.resolve(handle.cancel?.()) } catch (error) { pending = Promise.reject(error) }
    cancellations.add(pending)
    if (waitForSettlement) {
        // The next queued prompt must see the previous transcript after persistence and provider
        // teardown. A rejected settlement still releases the claim instead of wedging the chat.
        const completed = pending.then(() => true, () => false).finally(() => {
            releaseSession(runId)
            if (desktopCancellations.get(runId) === completed) desktopCancellations.delete(runId)
        })
        desktopCancellations.set(runId, completed)
    }
    void pending.finally(() => cancellations.delete(pending)).catch(() => {})
    return true
}

/** A timed-out Stop is retryable; its session stays claimed until the actual cleanup settles. */
export async function waitForRunCancellation(runId: string, timeoutMs = 5_000): Promise<boolean> {
    const pending = desktopCancellations.get(runId)
    if (!pending) return true
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
        return await Promise.race([pending, new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), timeoutMs) })])
    } finally { if (timer) clearTimeout(timer) }
}

export async function abortAllRuns(): Promise<void> {
    for (const id of [...controllers.keys()]) abortRun(id)
    await Promise.allSettled([...cancellations])
}

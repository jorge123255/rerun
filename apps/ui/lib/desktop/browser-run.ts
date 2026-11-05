// E3 (lane H): live browser preview for ordinary chat runs. Pure identity, projection and observer
// lifecycle; the React surface lives in components/desktop/browser-runs. Root supplies the trusted
// current-run projection, the current-state check and the passive transport.

export type BrowserRunIdentity = { agentId: string; sessionId: string; runId: string }
export type TrustedLiveScreen = { kind: 'browser' | 'computer'; site: string | null }
/** Exactly what root's trusted current-run projection emits for the selected conversation. */
export type TrustedCurrentRun = BrowserRunIdentity & { liveScreen: TrustedLiveScreen | null }

export type CurrentRunCheckResult =
    | { current: true; screen: 'running'; site: string | null }
    | { current: true; screen: 'stopped' | 'unavailable'; reason?: string }
    | { current: false }
/**
 * Root-owned server check: the exact coworker/session/run is still the active run, the owner is
 * enabled and not deleting, its browser/computer grant is current and the guest is already running.
 * It must never start, ensure or reconnect a runtime.
 */
export type CurrentRunCheck = (identity: BrowserRunIdentity, signal: AbortSignal) => Promise<CurrentRunCheckResult>
export type PassiveViewerTicket = { socketUrl: string; expiresAt: string }
/**
 * The accepted local viewer transport in watch mode only: no lease, no takeover, no input. It must
 * refuse rather than start a stopped guest (see handoff dependency H-D1).
 */
export type PassiveViewerTransport = { requestWatchTicket: (identity: BrowserRunIdentity, signal: AbortSignal) => Promise<PassiveViewerTicket> }

export type BrowserRunScreenState =
    | { status: 'idle' }
    | { status: 'loading' }
    | { status: 'live'; socketUrl: string; site: string | null }
    | { status: 'disconnected'; reason: string }
    | { status: 'unavailable'; reason: string }
    | { status: 'stopped' }

export type BrowserRunConversation = { agentId: string; sessionId: string; active: boolean; selected: boolean; visible: boolean }
export type BrowserRunEligibility =
    | { eligible: true; run: BrowserRunIdentity; site: string | null }
    | { eligible: false; reason: 'no-run' | 'no-screen' | 'inactive' | 'not-selected' | 'hidden' | 'mismatch' | 'takeover-pending' }

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/
export const BROWSER_RUN_LIMITS = { setupMs: 15_000, connectMs: 20_000, checkMs: 10_000, siteChars: 80 } as const

function isId(value: unknown): value is string {
    return typeof value === 'string' && ID.test(value)
}

/** Only the host name ever reaches the badge: no path, query, credentials or fragments. */
export function sanitizeSite(value: unknown): string | null {
    if (typeof value !== 'string' || !value.trim()) return null
    const raw = value.trim()
    let host = raw
    try {
        host = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`).hostname
    } catch {
        return null
    }
    host = host.replace(/^www\./i, '')
    if (!host || host.length > BROWSER_RUN_LIMITS.siteChars || !/^[A-Za-z0-9.-]+$/.test(host)) return null
    return host
}

/** Strict parse of root's projection; anything extra, malformed or partial fails closed. */
export function parseTrustedCurrentRun(value: unknown): TrustedCurrentRun | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null
    const record = value as Record<string, unknown>
    const keys = Object.keys(record).sort().join(',')
    if (keys !== 'agentId,liveScreen,runId,sessionId') return null
    if (!isId(record.agentId) || !isId(record.sessionId) || !isId(record.runId)) return null
    const screen = record.liveScreen
    if (screen === null) return { agentId: record.agentId, sessionId: record.sessionId, runId: record.runId, liveScreen: null }
    if (!screen || typeof screen !== 'object' || Array.isArray(screen)) return null
    const s = screen as Record<string, unknown>
    if (Object.keys(s).some(key => key !== 'kind' && key !== 'site')) return null
    if (s.kind !== 'browser' && s.kind !== 'computer') return null
    if (s.site !== undefined && s.site !== null && typeof s.site !== 'string') return null
    return { agentId: record.agentId, sessionId: record.sessionId, runId: record.runId, liveScreen: { kind: s.kind, site: sanitizeSite(s.site) } }
}

export function sameRun(a: BrowserRunIdentity | null | undefined, b: BrowserRunIdentity | null | undefined): boolean {
    return !!a && !!b && a.agentId === b.agentId && a.sessionId === b.sessionId && a.runId === b.runId
}

export function runKey(run: BrowserRunIdentity): string {
    return `${run.agentId}\u0000${run.sessionId}\u0000${run.runId}`
}

/**
 * Whether the selected conversation may show a live card now. Only the trusted projection for this
 * exact conversation with real screen work qualifies; selection, history or tool names never do.
 */
export function projectBrowserRunScreen(input: { trusted: TrustedCurrentRun | null; conversation: BrowserRunConversation; takeoverPending: boolean }): BrowserRunEligibility {
    const { trusted, conversation } = input
    if (!trusted) return { eligible: false, reason: 'no-run' }
    if (trusted.agentId !== conversation.agentId || trusted.sessionId !== conversation.sessionId) return { eligible: false, reason: 'mismatch' }
    if (!conversation.active) return { eligible: false, reason: 'inactive' }
    if (!conversation.selected) return { eligible: false, reason: 'not-selected' }
    if (!conversation.visible) return { eligible: false, reason: 'hidden' }
    if (!trusted.liveScreen) return { eligible: false, reason: 'no-screen' }
    // The pending takeover already shows this screen with its own controls (DesktopBrowserCard).
    if (input.takeoverPending) return { eligible: false, reason: 'takeover-pending' }
    return { eligible: true, run: { agentId: trusted.agentId, sessionId: trusted.sessionId, runId: trusted.runId }, site: trusted.liveScreen.site }
}

/** Saved runs stay saved output: a live card only for the exact trusted current run. */
export function projectSavedRun(savedRunId: string | null | undefined, trusted: TrustedCurrentRun | null, conversation: Pick<BrowserRunConversation, 'agentId' | 'sessionId'>): 'current' | 'historical' {
    if (!savedRunId || !trusted || !trusted.liveScreen) return 'historical'
    if (trusted.agentId !== conversation.agentId || trusted.sessionId !== conversation.sessionId) return 'historical'
    return trusted.runId === savedRunId ? 'current' : 'historical'
}

/** Ticket URLs stay in memory: never in drafts, history, logs or error text. */
export function isAcceptableSocketUrl(value: unknown): value is string {
    if (typeof value !== 'string' || value.length > 4096) return false
    try {
        const url = new URL(value)
        return (url.protocol === 'ws:' || url.protocol === 'wss:') && !url.username && !url.password
    } catch {
        return false
    }
}

const UNAVAILABLE = 'The screen is not available'
const WENT_AWAY = 'The screen went away'
const NO_CONNECT = 'The screen did not connect'

type Timer = ReturnType<typeof setTimeout>
export type BrowserRunObserverDeps = {
    run: BrowserRunIdentity
    check: CurrentRunCheck
    transport: PassiveViewerTransport
    onState: (state: BrowserRunScreenState) => void
    limits?: Partial<typeof BROWSER_RUN_LIMITS>
    now?: () => number
}

/**
 * One passive observer for one exact run. Every attempt is a generation: a late check, ticket or
 * socket reply from an older generation, or after dispose, is dropped. It never stops a guest,
 * releases a lease or touches another viewer; closing it only unmounts its own watch socket.
 */
export function createBrowserRunObserver(deps: BrowserRunObserverDeps) {
    const limits = { ...BROWSER_RUN_LIMITS, ...deps.limits }
    const now = deps.now ?? Date.now
    let generation = 0
    let disposed = false
    let controller: AbortController | undefined
    let watchdog: Timer | undefined
    let state: BrowserRunScreenState = { status: 'idle' }

    const emit = (gen: number, next: BrowserRunScreenState) => {
        if (disposed || gen !== generation) return
        state = next
        deps.onState(next)
    }
    const clearWatchdog = () => {
        if (watchdog) clearTimeout(watchdog)
        watchdog = undefined
    }
    const abortCurrent = () => {
        clearWatchdog()
        controller?.abort()
        controller = undefined
    }

    async function attempt(): Promise<void> {
        if (disposed) return
        abortCurrent()
        const gen = ++generation
        const own = new AbortController()
        controller = own
        const signal = AbortSignal.any([own.signal, AbortSignal.timeout(limits.setupMs)])
        emit(gen, { status: 'loading' })
        const alive = () => !disposed && gen === generation && !signal.aborted
        try {
            const checked = await deps.check(deps.run, AbortSignal.any([signal, AbortSignal.timeout(limits.checkMs)]))
            if (!alive()) return
            if (!checked.current) return emit(gen, { status: 'stopped' })
            if (checked.screen === 'stopped') return emit(gen, { status: 'stopped' })
            if (checked.screen !== 'running') return emit(gen, { status: 'unavailable', reason: UNAVAILABLE })
            const ticket = await deps.transport.requestWatchTicket(deps.run, signal)
            if (!alive()) return
            const expires = Date.parse(ticket?.expiresAt ?? '')
            if (!isAcceptableSocketUrl(ticket?.socketUrl) || !Number.isFinite(expires) || expires <= now()) return emit(gen, { status: 'unavailable', reason: UNAVAILABLE })
            // The run may have ended while the ticket was issued: confirm once more before showing it.
            const still = await deps.check(deps.run, AbortSignal.any([signal, AbortSignal.timeout(limits.checkMs)]))
            if (!alive()) return
            if (!still.current || still.screen !== 'running') return emit(gen, still.current && still.screen === 'unavailable' ? { status: 'unavailable', reason: UNAVAILABLE } : { status: 'stopped' })
            emit(gen, { status: 'live', socketUrl: ticket.socketUrl, site: sanitizeSite(still.site) })
            watchdog = setTimeout(() => {
                if (gen === generation && state.status === 'live') emit(gen, { status: 'disconnected', reason: NO_CONNECT })
            }, limits.connectMs)
        } catch {
            // Errors are reduced to fixed labels so a ticket or URL can never leak through them.
            if (!disposed && gen === generation) emit(gen, { status: 'unavailable', reason: UNAVAILABLE })
        } finally {
            if (controller === own && state.status !== 'live') controller = undefined
        }
    }

    return {
        start: () => attempt(),
        /** Retry revalidates the same run from the start; a cached ticket is never reused. */
        retry: () => attempt(),
        connected(socketUrl: string) {
            if (state.status === 'live' && state.socketUrl === socketUrl) clearWatchdog()
        },
        disconnected(socketUrl: string) {
            if (state.status !== 'live' || state.socketUrl !== socketUrl) return
            abortCurrent()
            emit(generation, { status: 'disconnected', reason: WENT_AWAY })
        },
        dispose() {
            if (disposed) return
            disposed = true
            generation++
            abortCurrent()
            state = { status: 'idle' }
        },
        get state() {
            return state
        },
        get generation() {
            return generation
        },
    }
}
export type BrowserRunObserver = ReturnType<typeof createBrowserRunObserver>

/**
 * Root's default passive transport over the existing screen client. Only safe to wire once H-D1
 * (watch tickets that refuse a stopped guest) is in place; until then root must keep the guard that
 * its CurrentRunCheck reports 'running' only for an already-running guest.
 */
export function createScreenClientPassiveTransport(requestDesktopScreenTicket: (agentId: string, mode: 'watch', signal?: AbortSignal) => Promise<PassiveViewerTicket>): PassiveViewerTransport {
    return { requestWatchTicket: (run, signal) => requestDesktopScreenTicket(run.agentId, 'watch', signal) }
}

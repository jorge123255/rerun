'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import type { DesktopClaudePlanSnapshot } from '@rerun/contracts'

export type DesktopClaudePlanPhase = 'idle' | 'waiting' | 'checking' | 'connected' | 'error'
export type DesktopClaudePlanAttempt = DesktopClaudePlanSnapshot
export type DesktopClaudePlanRuntime = {
    start: (attemptId: string | null, signal: AbortSignal) => Promise<DesktopClaudePlanAttempt>
    reconcile: (attemptId: string | null, signal: AbortSignal) => Promise<DesktopClaudePlanAttempt>
    submit: (attemptId: string, code: string, signal: AbortSignal) => Promise<DesktopClaudePlanAttempt>
    cancel: (attemptId: string, signal: AbortSignal) => Promise<DesktopClaudePlanAttempt>
    token?: (attemptId: string | null, token: string, signal: AbortSignal) => Promise<DesktopClaudePlanAttempt>
    disconnect?: (attemptId: string | null, signal: AbortSignal) => Promise<DesktopClaudePlanAttempt>
}

function authorizationDestination(value: string): string {
    const url = new URL(value)
    if (url.origin !== 'https://claude.ai' || url.pathname !== '/oauth/authorize' || url.username || url.password || url.hash) throw new Error('Invalid Claude sign-in destination.')
    return url.href
}
const phaseOf = (phase?: DesktopClaudePlanSnapshot['phase']): DesktopClaudePlanPhase => phase === 'waiting' || phase === 'checking' || phase === 'connected' || phase === 'error' ? phase : 'idle'

export function useDesktopClaudePlan({ runtime, onOpenAuthorization }: {
    runtime: DesktopClaudePlanRuntime
    onOpenAuthorization: (url: string) => void
}) {
    const owner = useMemo(() => ({ runtime, snapshot: null as DesktopClaudePlanAttempt | null, generation: 0, controller: null as AbortController | null, mounted: true, busy: false }), [runtime])
    const latest = useRef(owner)
    latest.current = owner
    const [view, setView] = useState({ owner, phase: 'idle' as DesktopClaudePlanPhase, error: null as string | null, opening: false })
    const shown = view.owner === owner ? view : { owner, phase: 'idle' as const, error: null, opening: false }
    const apply = (attempt: DesktopClaudePlanAttempt, generation: number) => {
        if (!owner.mounted || latest.current !== owner || generation !== owner.generation) return false
        owner.snapshot = attempt
        setView({ owner, phase: phaseOf(attempt.phase), error: attempt.error ?? (attempt.phase === 'expired' ? 'This code expired. Open Claude again.' : null), opening: false })
        return true
    }
    const run = async (operation: (signal: AbortSignal) => Promise<DesktopClaudePlanAttempt>, opening = false, checking = false) => {
        if (owner.busy || latest.current !== owner) return null
        owner.busy = true
        const generation = ++owner.generation, controller = new AbortController()
        owner.controller?.abort(); owner.controller = controller
        setView({ owner, phase: checking ? 'checking' : phaseOf(owner.snapshot?.phase), error: null, opening })
        try {
            const attempt = await operation(controller.signal)
            return apply(attempt, generation) ? attempt : null
        } catch {
            if (owner.mounted && latest.current === owner && generation === owner.generation) setView({ owner, phase: 'error', error: 'Claude sign-in could not be confirmed. Check its saved state before trying again.', opening: false })
            return null
        } finally { if (generation === owner.generation) owner.busy = false }
    }
    useEffect(() => {
        owner.mounted = true
        const controller = new AbortController(), generation = ++owner.generation
        owner.controller = controller
        void runtime.reconcile(null, controller.signal).then(attempt => {
            if (!owner.mounted || latest.current !== owner || generation !== owner.generation) return
            owner.snapshot = attempt
            setView({ owner, phase: phaseOf(attempt.phase), error: attempt.error ?? null, opening: false })
        }).catch(() => {
            if (owner.mounted && latest.current === owner && generation === owner.generation) setView({ owner, phase: 'error', error: 'Could not read Claude sign-in. Check its saved state.', opening: false })
        })
        return () => {
            owner.mounted = false; owner.generation++; owner.controller?.abort()
            const captured = owner.snapshot
            if (captured?.attemptId && ['waiting', 'checking'].includes(captured.phase)) void runtime.cancel(captured.attemptId, AbortSignal.timeout(10_000)).catch(() => {})
        }
    }, [owner, runtime])
    const start = async () => {
        const attempt = await run(signal => runtime.start(owner.snapshot?.attemptId ?? null, signal), true)
        if (attempt?.authorizeUrl && owner.mounted && latest.current === owner) {
            try { onOpenAuthorization(authorizationDestination(attempt.authorizeUrl)) }
            catch { setView({ owner, phase: 'error', error: 'Invalid Claude sign-in destination.', opening: false }) }
        }
    }
    const submit = async (raw: string) => {
        const id = owner.snapshot?.attemptId, code = raw.trim()
        if (code.startsWith('sk-ant') && runtime.token) return !!await token(code)
        if (!id || !code || owner.snapshot?.phase !== 'waiting') return false
        return (await run(signal => runtime.submit(id, code, signal), false, true))?.phase === 'connected'
    }
    const cancel = async () => {
        const id = owner.snapshot?.attemptId
        if (!id) return
        owner.controller?.abort(); owner.busy = false
        await run(signal => runtime.cancel(id, signal))
    }
    const reconcile = () => run(signal => runtime.reconcile(owner.snapshot?.attemptId ?? null, signal))
    const token = async (value: string) => runtime.token && (await run(signal => runtime.token!(owner.snapshot?.attemptId ?? null, value, signal), false, true))?.phase === 'connected'
    const disconnect = () => runtime.disconnect ? run(signal => runtime.disconnect!(owner.snapshot?.attemptId ?? null, signal)) : Promise.resolve(null)
    return { attemptId: owner.snapshot?.attemptId ?? null, phase: shown.phase, error: shown.error, opening: shown.opening, start, submit, cancel, reconcile, token, disconnect }
}

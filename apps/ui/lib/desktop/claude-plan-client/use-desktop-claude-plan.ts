'use client'

import { useEffect, useRef, useState } from 'react'

export type DesktopClaudePlanPhase = 'idle' | 'waiting' | 'checking' | 'connected' | 'error'
export type DesktopClaudePlanAttempt = {
    attemptId: string
    phase: DesktopClaudePlanPhase
    authorizeUrl?: string
    error?: string
}
export type DesktopClaudePlanRuntime = {
    start: (attemptId: string | null, signal: AbortSignal) => Promise<DesktopClaudePlanAttempt>
    reconcile: (attemptId: string | null, signal: AbortSignal) => Promise<DesktopClaudePlanAttempt>
    submit: (attemptId: string, code: string, signal: AbortSignal) => Promise<DesktopClaudePlanAttempt>
    cancel: (attemptId: string, signal: AbortSignal) => Promise<DesktopClaudePlanAttempt>
}

function authorizationDestination(value: string): string {
    const url = new URL(value)
    if (url.protocol !== 'https:' || url.username || url.password || url.hash || (url.port && url.port !== '443')) throw new Error('Invalid Claude sign-in destination.')
    return url.href
}

export function useDesktopClaudePlan({ runtime, onOpenAuthorization }: {
    runtime: DesktopClaudePlanRuntime
    onOpenAuthorization: (url: string) => void
}) {
    const [attemptId, setAttemptId] = useState<string | null>(null)
    const [phase, setPhase] = useState<DesktopClaudePlanPhase>('idle')
    const [error, setError] = useState<string | null>(null)
    const [opening, setOpening] = useState(false)
    const currentAttempt = useRef<string | null>(null)
    const starting = useRef(false)
    const submitting = useRef(false)
    const epoch = useRef(0)
    const controller = useRef<AbortController | null>(null)
    const mounted = useRef(true)

    useEffect(() => {
        mounted.current = true
        return () => { mounted.current = false; epoch.current++; controller.current?.abort() }
    }, [])

    const begin = () => {
        const generation = ++epoch.current
        controller.current?.abort()
        const pending = new AbortController()
        controller.current = pending
        return { generation, pending }
    }
    const apply = (attempt: DesktopClaudePlanAttempt, generation: number) => {
        if (!mounted.current || generation !== epoch.current) return
        currentAttempt.current = attempt.attemptId
        setAttemptId(attempt.attemptId)
        setPhase(attempt.phase)
        setError(attempt.error ?? null)
    }
    const fail = (generation: number, fallback: string) => {
        if (!mounted.current || generation !== epoch.current) return
        setPhase('error')
        setError(fallback)
    }

    const start = async () => {
        if (starting.current) return
        starting.current = true
        const { generation, pending } = begin()
        setOpening(true)
        setError(null)
        try {
            const attempt = await runtime.start(currentAttempt.current, pending.signal)
            apply(attempt, generation)
            if (generation === epoch.current && attempt.authorizeUrl) onOpenAuthorization(authorizationDestination(attempt.authorizeUrl))
        } catch (cause) {
            fail(generation, cause instanceof Error ? cause.message : 'Could not start the connection.')
        } finally {
            starting.current = false
            if (generation === epoch.current) setOpening(false)
        }
    }

    const submit = async (raw: string): Promise<boolean> => {
        const code = raw.trim()
        const id = currentAttempt.current
        if (!id || !code || submitting.current || phase === 'connected') return false
        submitting.current = true
        const { generation, pending } = begin()
        setPhase('checking')
        setError(null)
        try {
            const attempt = await runtime.submit(id, code, pending.signal)
            apply(attempt, generation)
            return generation === epoch.current && attempt.phase === 'connected'
        } catch (cause) {
            fail(generation, cause instanceof Error ? cause.message : 'Could not check the code. Try again.')
            return false
        } finally {
            submitting.current = false
        }
    }

    const cancel = async () => {
        const id = currentAttempt.current
        if (!id || phase === 'connected' || phase === 'idle') return
        const { generation, pending } = begin()
        try {
            const attempt = await runtime.cancel(id, pending.signal)
            apply(attempt, generation)
        } catch (cause) {
            fail(generation, cause instanceof Error ? cause.message : 'Could not cancel this sign-in attempt.')
        }
    }

    const reconcile = async () => {
        const { generation, pending } = begin()
        try {
            const attempt = await runtime.reconcile(currentAttempt.current, pending.signal)
            apply(attempt, generation)
        } catch (cause) {
            fail(generation, cause instanceof Error ? cause.message : 'Could not restore the connection attempt.')
        }
    }

    return { attemptId, phase, error, opening, start, submit, cancel, reconcile }
}

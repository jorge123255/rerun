'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { desktopBoardStateSchema, type DesktopBoardState, type DesktopSpaceCommand } from '@/lib/desktop/spaces'
import { holdDraftAdmission, isDesktopQuitting } from '@/lib/desktop/draft-writes'

type Attempt = { requestId: string; expectedRevision: number; command: DesktopSpaceCommand }

// The board is an independent durable projection. A rename/provider/roster response must never
// put an old position back, and retrying a lost reply must not create a second Box.
export function useDesktopBoardState(initial: DesktopBoardState | undefined) {
    const [board, setBoard] = useState(initial)
    const latest = useRef(initial)
    const enabled = useRef(initial !== undefined)
    const alive = useRef(true)
    const reading = useRef<AbortController | null>(null)
    const readGeneration = useRef(0)
    const attempt = useRef<Attempt | null>(null)
    const writing = useRef(false)
    const [saving, setSaving] = useState(false)
    const [error, setError] = useState<string>()
    useEffect(() => {
        alive.current = true
        return () => { alive.current = false; readGeneration.current++; reading.current?.abort() }
    }, [])

    const accept = useCallback((value: unknown) => {
        const next = desktopBoardStateSchema.parse(value)
        if (alive.current && (!latest.current || next.revision >= latest.current.revision)) {
            latest.current = next
            setBoard(next)
        }
    }, [])

    const refresh = useCallback(async (lifetime?: AbortSignal) => {
        if (!enabled.current || !alive.current || lifetime?.aborted || isDesktopQuitting()) return false
        reading.current?.abort()
        const controller = new AbortController()
        const generation = ++readGeneration.current
        reading.current = controller
        const timeout = setTimeout(() => controller.abort(), 15_000)
        try {
            const signal = lifetime ? AbortSignal.any([lifetime, controller.signal]) : controller.signal
            const response = await fetch('/api/desktop/spaces', { cache: 'no-store', signal })
            const body = await response.json()
            if (!response.ok) throw new Error(body.error || 'Could not refresh the board. Try again.')
            if (!alive.current || generation !== readGeneration.current || signal.aborted) return false
            accept(body.board)
            if (!attempt.current) setError(undefined)
            return true
        } catch (cause) {
            if (!lifetime?.aborted && alive.current && generation === readGeneration.current) setError(cause instanceof Error && cause.name !== 'AbortError'
                ? cause.message : 'Could not refresh the board. Try again.')
            return false
        } finally {
            clearTimeout(timeout)
            if (reading.current === controller) reading.current = null
        }
    }, [accept])

    const command = useCallback(async (value: DesktopSpaceCommand) => {
        if (!latest.current || !alive.current || isDesktopQuitting()) throw new Error('The board is not available right now.')
        if (writing.current) throw new Error('Wait for the current board change to finish.')
        if (attempt.current && JSON.stringify(attempt.current.command) !== JSON.stringify(value))
            throw new Error('Retry the previous board change before making another change.')
        const pending = attempt.current ?? { requestId: crypto.randomUUID(), expectedRevision: latest.current.revision, command: value }
        attempt.current = pending
        writing.current = true
        setSaving(true)
        setError(undefined)
        reading.current?.abort()
        readGeneration.current++
        const release = holdDraftAdmission()
        const controller = new AbortController()
        const timeout = setTimeout(() => controller.abort(), 20_000)
        try {
            const response = await fetch('/api/desktop/spaces', {
                method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(pending), signal: controller.signal,
            })
            const body = await response.json()
            if (!response.ok) {
                if (response.status >= 400 && response.status < 500) {
                    // A definite rejection has not applied this operation. Refresh before the
                    // user reviews/retries; never silently replay a move against a newer layout.
                    attempt.current = null
                    await refresh()
                }
                throw new Error(body.error || 'Could not save the board. Try again.')
            }
            accept(body.board)
            attempt.current = null
            if (alive.current) setError(undefined)
        } catch (cause) {
            const message = cause instanceof Error && cause.name !== 'AbortError' ? cause.message : 'Could not confirm the board change. Retry to check it.'
            if (alive.current) setError(message)
            throw new Error(message)
        } finally {
            clearTimeout(timeout)
            writing.current = false
            if (alive.current) setSaving(false)
            release()
        }
    }, [accept, refresh])

    const retry = useCallback(async () => {
        if (attempt.current) await command(attempt.current.command)
        else await refresh()
    }, [command, refresh])

    return { board, saving, error, command, refresh, retry, current: () => latest.current }
}

'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createDesktopToolInstallClient, DesktopToolInstallClientError, type DesktopToolInstallClient, type DesktopToolInstallSnapshot } from '@/lib/desktop/tool-install-client'

export function useDesktopToolInstall(sessionId: string, operationId: string, active = true) {
    const client = useMemo(() => createDesktopToolInstallClient(sessionId), [sessionId])
    const [snapshot, setSnapshot] = useState<DesktopToolInstallSnapshot | null>(null)
    const [loading, setLoading] = useState(true)
    const [error, setError] = useState('')
    const [action, setAction] = useState<'decision' | 'inspect' | null>(null)
    const epoch = useRef(0)
    const mounted = useRef(true)

    useEffect(() => {
        mounted.current = true
        return () => { mounted.current = false; epoch.current++; client.dispose() }
    }, [client])

    const refresh = useCallback(async () => {
        const current = ++epoch.current
        setLoading(true)
        setError('')
        try {
            const next = await client.read(operationId)
            if (mounted.current && epoch.current === current) setSnapshot(next)
        } catch (cause) {
            if (mounted.current && epoch.current === current) setError(cause instanceof Error ? cause.message : 'Could not read tool installation.')
        } finally {
            if (mounted.current && epoch.current === current) setLoading(false)
        }
    }, [client, operationId])

    useEffect(() => {
        if (!active) {
            epoch.current++
            setSnapshot(null)
            setError('')
            return
        }
        setSnapshot(null)
        void refresh()
    }, [active, refresh])

    useEffect(() => {
        if (!active || snapshot?.status !== 'installing') return
        const timer = setInterval(() => void refresh(), 3_000)
        return () => clearInterval(timer)
    }, [active, refresh, snapshot?.status])

    async function settle(next: DesktopToolInstallSnapshot | null, cause: unknown, fallback: string) {
        if (cause instanceof DesktopToolInstallClientError && cause.snapshot) setSnapshot(cause.snapshot)
        setError(cause instanceof Error ? cause.message : fallback)
        if (next) setSnapshot(next)
    }

    const decide = useCallback(async (decision: 'approved' | 'declined', note?: string) => {
        if (!snapshot || action) return
        setAction('decision')
        setError('')
        try {
            setSnapshot(await client.decide(snapshot, decision, note))
        } catch (cause) {
            await settle(null, cause, 'Could not send this decision. Try again.')
        } finally { setAction(null) }
    }, [action, client, snapshot])

    const inspect = useCallback(async () => {
        if (!snapshot || action) return
        setAction('inspect')
        setError('')
        try {
            setSnapshot(await client.inspect(snapshot))
        } catch (cause) {
            await settle(null, cause, 'Could not inspect this installation. Try again.')
        } finally { setAction(null) }
    }, [action, client, snapshot])

    return { snapshot, loading, error, action, refresh, decide, inspect }
}

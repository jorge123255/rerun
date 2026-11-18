import type { MacPhoneCoworkerSetup, MacPhoneCoworkerSettingsChange } from '@rerun/mac-contracts/mac-phone-pairing'
import { randomUUID } from 'expo-crypto'
import { useFocusEffect } from 'expo-router'
import { useCallback, useRef, useState } from 'react'
import { AppState } from 'react-native'

import type { MacHub } from '@/mac/hub'
import { isDefiniteSettingsRefusal } from '@/mac/settings-retries'

type SetupHub = Pick<MacHub, 'readCoworkerSetup' | 'changeCoworkerSettings' | 'unconfirmedSettingsChange'>
type SetupChange = Extract<MacPhoneCoworkerSettingsChange, { field: 'setup' }>
type Action = SetupChange['body']['action']
const REFRESH_MS = 3000

// Read-only recovery runs only while the coworker screen is in front. The Mac owns the kickoff,
// its chat id and completion. Opening the phone screen must never itself submit a setup action.
export function useMacCoworkerSetup(hub: SetupHub | null, agentId: string, openChat: (id: string) => void) {
    const [view, setView] = useState<MacPhoneCoworkerSetup | null>(null)
    const [error, setError] = useState<string | null>(null)
    const [saving, setSaving] = useState(false)
    const [uncertain, setUncertain] = useState<SetupChange | null>(null)
    const scope = useRef<AbortController | null>(null)
    const current = useRef<MacPhoneCoworkerSetup | null>(null)
    const lock = useRef(false)
    const reading = useRef(false)
    const version = useRef(0)
    const pausePolling = useRef(false)
    const read = useCallback(async (signal: AbortSignal) => {
        if (!hub) return null
        const seq = ++version.current
        let next: MacPhoneCoworkerSetup
        try {
            next = await hub.readCoworkerSetup(agentId, signal)
        } catch (reason) {
            if (signal.aborted || seq !== version.current) return null
            const status = typeof reason === 'object' && reason && 'status' in reason ? reason.status : null
            if (status === 401 || status === 403 || status === 404 || status === 405) {
                current.current = null
                setView(null)
            }
            throw reason
        }
        if (signal.aborted || seq !== version.current) return null
        if (next.agentId !== agentId) {
            current.current = null
            setView(null)
            throw new Error('not_found')
        }
        current.current = next
        setView(next)
        return next
    }, [agentId, hub])
    const refresh = useCallback(async () => {
        const signal = scope.current?.signal
        if (!signal || signal.aborted || lock.current || reading.current) return
        reading.current = true
        try {
            const next = await read(signal)
            if (next) { pausePolling.current = false; setError(null) }
        } catch (reason) {
            if (!signal.aborted) {
                // Older listeners may not have the setup endpoint. Normal chats stay usable.
                // Recheck on an explicit retry or when the person returns, never in a failure loop.
                pausePolling.current = true
                setError(reason instanceof Error ? reason.message : 'unavailable')
            }
        } finally {
            if (!signal.aborted) reading.current = false
        }
    }, [read])
    useFocusEffect(useCallback(() => {
        if (!hub) return
        const controller = new AbortController()
        scope.current = controller
        current.current = null
        pausePolling.current = false
        lock.current = false
        reading.current = false
        setView(null)
        setSaving(false)
        setError(null)
        const prior = hub.unconfirmedSettingsChange(agentId, 'setup')
        setUncertain(prior?.field === 'setup' ? prior : null)
        void refresh()
        const timer = setInterval(() => {
            if (AppState.currentState === 'active' && !pausePolling.current && current.current?.pending) void refresh()
        }, REFRESH_MS)
        const foreground = AppState.addEventListener('change', state => { if (state === 'active') void refresh() })
        return () => { controller.abort(); scope.current = null; clearInterval(timer); foreground.remove() }
    }, [agentId, hub, refresh]))

    const act = async (action: Action) => {
        const signal = scope.current?.signal
        const before = current.current
        if (!hub || !before || !signal || signal.aborted || lock.current) return
        if (action === 'continue' && !before.skipped && before.sessionId && !uncertain) {
            openChat(before.sessionId)
            return
        }
        if (!before.permissions.changeSettings || (uncertain && uncertain.body.action !== action)) return
        const change: SetupChange = uncertain ?? { field: 'setup', body: { action, expectedRevision: before.revision, requestId: randomUUID() } }
        lock.current = true
        ++version.current
        setSaving(true)
        setError(null)
        let acknowledged = false
        try {
            await hub.changeCoworkerSettings(agentId, change, signal)
            acknowledged = true
            if (signal.aborted) return
            setUncertain(null)
            pausePolling.current = false
            const next = await read(signal)
            if (next && action !== 'skip' && next.sessionId && !next.skipped) openChat(next.sessionId)
        } catch (reason) {
            if (signal.aborted) return
            pausePolling.current = true
            const replay = !acknowledged && !isDefiniteSettingsRefusal(reason)
            setUncertain(replay ? change : null)
            setError(reason instanceof Error ? reason.message : 'unavailable')
            try { await read(signal) } catch { /* the original error remains visible with Retry */ }
        } finally {
            if (!signal.aborted) { lock.current = false; setSaving(false) }
        }
    }
    return { view, error, saving, uncertain, act, refresh }
}

export type MacGuidedSetup = ReturnType<typeof useMacCoworkerSetup>

'use client'

import { useCallback, useEffect, useMemo } from 'react'
import { toast } from 'sonner'
import { create } from 'zustand'
import { coworkerRuleOf, mergeNotificationPrefs, normalizeNotificationPrefs, type CoworkerRule, type NotificationPrefs, type NotificationPrefsPatch } from '@rerun/contracts'
import { DESKTOP_NOTIFICATION_PREFS_URL, desktopNotificationPrefsPatchSchema } from './notifications'
import { holdDraftAdmission, isDesktopQuitting } from './draft-writes'

// The desktop twin of useNotificationPrefs: the same pending-merge and one-write-at-a-time
// queue, backed by the local preferences route instead of the hosted users row. One shared
// store keeps the bell, the routine's « Notify me » switch and the settings surface in
// agreement between writes; the server merges every patch onto the stored value, so a surface
// that only touches one field never clobbers the rest.
const useDesktopPrefsStore = create<{
    confirmed: NotificationPrefs | null
    pending: NotificationPrefs | null
    inFlight: number
}>(() => ({ confirmed: null, pending: null, inFlight: 0 }))

let loading: Promise<void> | null = null
let saving: Promise<void> = Promise.resolve()

function refreshDesktopNotificationPrefs(): Promise<void> {
    loading ??= fetch(DESKTOP_NOTIFICATION_PREFS_URL, { cache: 'no-store' })
        .then(async response => {
            if (!response.ok) throw new Error('unreadable')
            const saved = normalizeNotificationPrefs(await response.json())
            useDesktopPrefsStore.setState(state => ({ confirmed: saved, pending: state.inFlight === 0 ? null : state.pending }))
        })
        .catch(() => {})
        .finally(() => { loading = null })
    return loading
}

export function useDesktopNotificationPrefs() {
    const confirmed = useDesktopPrefsStore(state => state.confirmed)
    const pending = useDesktopPrefsStore(state => state.pending)

    useEffect(() => { void refreshDesktopNotificationPrefs() }, [])

    const prefs = useMemo(() => pending ?? confirmed ?? normalizeNotificationPrefs(undefined), [pending, confirmed])

    const update = useCallback((patch: NotificationPrefsPatch) => {
        if (isDesktopQuitting()) return
        const parsed = desktopNotificationPrefsPatchSchema.safeParse(patch)
        if (!parsed.success) {
            toast.error('Could not save your notification settings', { description: 'Choose a valid notification scope, channel or coworker rule.' })
            return
        }
        const current = useDesktopPrefsStore.getState().pending ?? useDesktopPrefsStore.getState().confirmed ?? normalizeNotificationPrefs(undefined)
        useDesktopPrefsStore.setState(state => ({ pending: mergeNotificationPrefs(current, parsed.data), inFlight: state.inFlight + 1 }))
        const release = holdDraftAdmission()
        saving = saving
            .then(async () => {
                const response = await fetch(DESKTOP_NOTIFICATION_PREFS_URL, {
                    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(parsed.data), cache: 'no-store',
                    signal: AbortSignal.timeout(10_000),
                })
                if (!response.ok) throw new Error('Could not save your notification settings')
                const saved = normalizeNotificationPrefs(await response.json())
                useDesktopPrefsStore.setState(state => ({ confirmed: saved, pending: state.inFlight === 1 ? null : state.pending }))
            })
            .catch(() => {
                useDesktopPrefsStore.setState({ pending: null })
                toast.error('Could not save your notification settings')
            })
            .finally(() => {
                useDesktopPrefsStore.setState(state => ({ inFlight: state.inFlight - 1 }))
                release()
            })
    }, [])

    const setCoworkerRule = useCallback((agentId: string, rule: CoworkerRule) => update({ coworkers: { [agentId]: rule } }), [update])

    const ruleOf = useCallback((agentId: string | null | undefined) => coworkerRuleOf(prefs, agentId), [prefs])

    return { prefs, update, setCoworkerRule, ruleOf, ready: confirmed !== null }
}

'use client'

import { useCallback, useEffect, useMemo } from 'react'
import { useDesktopLocale } from '@/components/desktop/DesktopLocale'
import { toast } from 'sonner'
import { create } from 'zustand'
import { z } from 'zod'
import { coworkerRuleOf, mergeNotificationPrefs, normalizeNotificationPrefs, type CoworkerRule, type NotificationPrefs, type NotificationPrefsPatch } from '@rerun/contracts'
import { DESKTOP_NOTIFICATION_PREFS_URL, desktopNotificationPrefsPatchSchema } from './notifications'
import { holdDraftAdmission, isDesktopQuitting } from './draft-writes'

// Every local notification surface shares one authoritative snapshot and write queue. Pending
// patches are replayed over each acknowledged value, so a failed earlier write cannot discard a
// later optimistic edit. Reads never overtake admitted writes or replace a newer acknowledgement.
const useDesktopPrefsStore = create<{
    confirmed: NotificationPrefs | null; pending: NotificationPrefs | null
    loading: boolean; readError: string | null; saveError: string | null
}>(() => ({ confirmed: null, pending: null, loading: false, readError: null, saveError: null }))
const queued: { id: number; patch: NotificationPrefsPatch }[] = []
let revision = 0
let nextId = 0
let loading: Promise<void> | null = null
let reading: AbortController | null = null
let saving: Promise<void> = Promise.resolve()
const SAVE_ERROR = 'Could not save your notification settings. Try again.'
const READ_ERROR = 'Could not load your notification settings. Try again.'
const savedPrefsSchema = desktopNotificationPrefsPatchSchema.required().extend({ version: z.literal(2) })
const readSavedPrefs = (value: unknown) => normalizeNotificationPrefs(savedPrefsSchema.parse(value))

async function bounded<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
    if (signal.aborted) { void work.catch(() => {}); throw signal.reason }
    let stop!: () => void
    const cancelled = new Promise<never>((_, reject) => { stop = () => reject(signal.reason); signal.addEventListener('abort', stop, { once: true }) })
    try { return await Promise.race([work, cancelled]) }
    finally { signal.removeEventListener('abort', stop) }
}
function publishPending() {
    const confirmed = useDesktopPrefsStore.getState().confirmed
    useDesktopPrefsStore.setState({ pending: confirmed && queued.length ? queued.reduce((value, entry) => mergeNotificationPrefs(value, entry.patch), confirmed) : null })
}
export function refreshDesktopNotificationPrefs(): Promise<void> {
    if (loading) return loading
    const controller = new AbortController()
    reading = controller
    useDesktopPrefsStore.setState({ loading: true })
    loading = (async () => {
        const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)])
        try {
            await bounded(saving, signal)
            if (isDesktopQuitting()) return
            const version = revision
            const response = await bounded(fetch(DESKTOP_NOTIFICATION_PREFS_URL, { cache: 'no-store', signal }), signal)
            if (!response.ok) throw new Error(READ_ERROR)
            const saved = readSavedPrefs(await bounded(response.json(), signal))
            if (signal.aborted || version !== revision || isDesktopQuitting()) return
            useDesktopPrefsStore.setState({ confirmed: saved, readError: null })
            publishPending()
        } catch {
            if (!controller.signal.aborted && !isDesktopQuitting()) useDesktopPrefsStore.setState({ readError: READ_ERROR })
        } finally {
            if (reading === controller) { reading = null; loading = null; useDesktopPrefsStore.setState({ loading: false }) }
        }
    })()
    return loading
}

export function useDesktopNotificationPrefs() {
    const { t } = useDesktopLocale()
    const confirmed = useDesktopPrefsStore(state => state.confirmed)
    const pending = useDesktopPrefsStore(state => state.pending)
    const readError = useDesktopPrefsStore(state => state.readError)
    const saveError = useDesktopPrefsStore(state => state.saveError)
    const busy = useDesktopPrefsStore(state => state.loading)
    useEffect(() => { void refreshDesktopNotificationPrefs() }, [])
    const prefs = useMemo(() => pending ?? confirmed ?? normalizeNotificationPrefs(undefined), [pending, confirmed])
    const update = useCallback((patch: NotificationPrefsPatch) => {
        const state = useDesktopPrefsStore.getState()
        if (isDesktopQuitting() || !state.confirmed || state.readError) return
        const parsed = desktopNotificationPrefsPatchSchema.safeParse(patch)
        if (!parsed.success) { useDesktopPrefsStore.setState({ saveError: 'Choose a valid notification scope, channel or coworker rule.' }); return }
        reading?.abort()
        revision++
        const entry = { id: ++nextId, patch: parsed.data }
        queued.push(entry)
        publishPending()
        useDesktopPrefsStore.setState({ saveError: null })
        const release = holdDraftAdmission()
        saving = saving.then(async () => {
            const signal = AbortSignal.timeout(10_000)
            try {
                const response = await bounded(fetch(DESKTOP_NOTIFICATION_PREFS_URL, {
                    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(entry.patch), cache: 'no-store', signal,
                }), signal)
                if (!response.ok) throw new Error(SAVE_ERROR)
                const saved = readSavedPrefs(await bounded(response.json(), signal))
                revision++
                useDesktopPrefsStore.setState({ confirmed: saved })
            } catch {
                useDesktopPrefsStore.setState({ saveError: SAVE_ERROR })
                toast.error(t('notificationUI.saveFailed'))
            } finally {
                const index = queued.findIndex(item => item.id === entry.id)
                if (index >= 0) queued.splice(index, 1)
                publishPending()
                release()
            }
        })
    }, [t])
    const setCoworkerRule = useCallback((agentId: string, rule: CoworkerRule) => update({ coworkers: { [agentId]: rule } }), [update])
    const ruleOf = useCallback((agentId: string | null | undefined) => coworkerRuleOf(prefs, agentId), [prefs])
    return { prefs, update, setCoworkerRule, ruleOf, ready: confirmed !== null && !readError, loading: busy,
        readError: readError ? t('notificationUI.loadFailed') : null,
        saveError: saveError ? t(saveError === SAVE_ERROR ? 'notificationUI.saveFailed' : 'notificationUI.invalid') : null,
        refresh: refreshDesktopNotificationPrefs }
}

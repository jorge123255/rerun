'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { routineKey } from '@rerun/ui/foreman'
import type { DesktopWorkspaceRoutine, DesktopWorkspaceRoutineChat } from '@rerun/contracts'
import { desktopLocaleTag } from '@/lib/desktop/locale'
import { desktopScheduleSummary } from '@/lib/desktop/schedule-description'
import type { DesktopWorkspaceRoutinesClient } from '@/lib/desktop/workspace-routines/client'
import { nextRunAt, routineFrequency } from '@/lib/schedules/cron'
import { useDesktopLocale } from '../DesktopLocale'

function useNow(intervalMs: number): number {
    const [now, setNow] = useState(() => Date.now())
    useEffect(() => {
        const id = setInterval(() => setNow(Date.now()), intervalMs)
        return () => clearInterval(id)
    }, [intervalMs])
    return now
}

// What a row needs to be drawn by RoutineList and acted on: the workspace's routines (the Chief of
// Staff's list) and one coworker's saved tasks both have it.
export type DesktopRoutineRow = {
    agentId: string
    slug: string
    name: string
    enabled: boolean
    revision: string
    nextRunAt: string | null
    cron?: string | null
    runAt?: string | null
    timezone?: string | null
    lastRunAt?: string | null
    runningSince?: string | null
    setupPending?: boolean
}

/**
 * A list of routines as `RoutineList` draws them, and what its rows do: pause or resume one, rename
 * it, run it now (upstream #318's useRoutines). The workspace's list (the Chief of Staff) and a
 * coworker's own are read by their screens, each its own way, and act the same way here.
 */
export function useDesktopRoutines<T extends DesktopRoutineRow>({ client, routines, active = true, patch, onSaved, reload, onOpenChat }: {
    client: Pick<DesktopWorkspaceRoutinesClient, 'mutate'>
    // Null until the list is read.
    routines: readonly T[] | null
    // False while the list is out of sight: nothing is started from it.
    active?: boolean
    // What a row shows before its change is saved, and what it goes back to if the save fails.
    patch: (key: string, change: { enabled?: boolean; name?: string }) => void
    // The routine as the engine saved it.
    onSaved: (key: string, routine: DesktopWorkspaceRoutine) => void
    reload: () => Promise<void> | void
    onOpenChat: (chat: DesktopWorkspaceRoutineChat) => void
}) {
    const { t, language } = useDesktopLocale()
    const locale = desktopLocaleTag(language.locale)
    const [saving, setSaving] = useState<string[]>([])
    const [renamingKey, setRenamingKey] = useState<string | null>(null)
    // A switched row keeps the place it had when it was switched, until that hour has passed: paused,
    // it would otherwise drop at once into the folded Paused group, out of sight of the hand that did it.
    const [heldNextRuns, setHeldNextRuns] = useState<Record<string, string | null>>({})
    const now = useNow(30_000)
    const requestIds = useRef(new Map<string, string>())
    const acting = useRef(new Set<string>())
    const lifetime = useRef(0)
    useEffect(() => { ++lifetime.current; return () => { ++lifetime.current } }, [client, active])

    const rows = useMemo(() => {
        if (!routines) return null
        const at = new Date(now)
        return routines.map(routine => {
            const key = routineKey(routine)
            const held = heldNextRuns[key]
            const stillHeld = key in heldNextRuns && (held === null || new Date(held).getTime() > now)
            const timing = { cron: routine.cron ?? null, runAt: routine.runAt ?? null, timezone: routine.timezone ?? null }
            const frequency = routine.runAt
                ? desktopScheduleSummary(timing, t, locale)
                : routineFrequency(timing, (key, values) => t(`routines.${key}`, values), locale)
            return { ...routine, frequency, runningSince: routine.runningSince ?? null, nextRunAt: stillHeld ? held : nextRunAt({ ...timing, enabled: routine.enabled, lastRunAt: routine.lastRunAt ?? null }, at) }
        })
    }, [routines, now, heldNextRuns, locale, t])

    const requestId = (action: string, revision: string) => {
        const key = `${action}:${revision}`
        const existing = requestIds.current.get(key)
        if (existing) return existing
        const created = crypto.randomUUID()
        requestIds.current.set(key, created)
        return created
    }

    const toggle = async (routine: T, enabled: boolean) => {
        const key = routineKey(routine)
        setHeldNextRuns(current => key in current ? current : { ...current, [key]: routine.nextRunAt })
        patch(key, { enabled })
        setSaving(current => [...current, key])
        try {
            const result = await client.mutate({ action: 'toggle', agentId: routine.agentId, slug: routine.slug, expectedRevision: routine.revision, requestId: requestId(`toggle:${routine.agentId}:${routine.slug}:${enabled}`, routine.revision), enabled })
            onSaved(key, result.routine)
            await reload()
        } catch (cause) {
            patch(key, { enabled: !enabled })
            toast.error(t(enabled ? 'routines.resumeFailed' : 'routines.pauseFailed', { name: routine.name }), { description: cause instanceof Error ? cause.message : undefined })
        } finally {
            setSaving(current => current.filter(value => value !== key))
        }
    }

    const rename = async (routine: T, name: string) => {
        const key = routineKey(routine)
        setRenamingKey(null)
        patch(key, { name })
        try {
            const result = await client.mutate({ action: 'rename', agentId: routine.agentId, slug: routine.slug, expectedRevision: routine.revision, requestId: requestId(`rename:${routine.agentId}:${routine.slug}:${name}`, routine.revision), name })
            onSaved(key, result.routine)
            await reload()
        } catch (cause) {
            patch(key, { name: routine.name })
            toast.error(t('routines.renameFailed', { name: routine.name }), { description: cause instanceof Error ? cause.message : undefined })
        }
    }

    const runNow = async (routine: T) => {
        const key = `run:${routine.agentId}:${routine.slug}:${routine.revision}`
        if (!active || acting.current.has(key)) return
        acting.current.add(key)
        const own = lifetime.current
        const id = requestId(key, routine.revision)
        try {
            const result = await client.mutate({ action: 'run', agentId: routine.agentId, slug: routine.slug, expectedRevision: routine.revision, requestId: id })
            // An acknowledged run ends this attempt. A later human click starts another,
            // while an unknown acknowledgement retains this exact request for retry.
            requestIds.current.delete(`${key}:${routine.revision}`)
            if (own !== lifetime.current) return
            if (result.chat) onOpenChat(result.chat)
            else toast.success(t('routines.started', { name: routine.name }))
            await reload()
        } catch (cause) {
            if (own === lifetime.current) toast.error(t('routines.runFailed', { name: routine.name }), { description: cause instanceof Error ? cause.message : undefined })
        } finally { acting.current.delete(key) }
    }

    return {
        routines: rows,
        now,
        isSaving: (routine: Pick<DesktopRoutineRow, 'agentId' | 'slug'>) => saving.includes(routineKey(routine)),
        renamingKey,
        startRename: (routine: Pick<DesktopRoutineRow, 'agentId' | 'slug'>) => setRenamingKey(routineKey(routine)),
        cancelRename: () => setRenamingKey(null),
        toggle,
        rename,
        runNow,
        requestId,
    }
}

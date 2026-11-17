'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { EmptyState } from '@/components/ui/empty-state'
import { CalendarClockIcon } from '@/lib/icons'
import { cn } from '@/lib/utils'
import { RoutineList, routineKey } from '@rerun/ui/foreman'
import type { DesktopWorkspaceRoutinesClient } from '@/lib/desktop/workspace-routines/client'
import { scheduleRequest } from '@/lib/desktop/schedules/client'
import type { DesktopScheduleEditInput, DesktopWorkspaceRoutine, DesktopWorkspaceRoutineChat, DesktopWorkspaceRoutinesView } from '@rerun/contracts'
import { useDesktopLocale } from '../../DesktopLocale'
import { DesktopWorkspaceRoutineEditor } from './DesktopWorkspaceRoutineEditor'
import { DesktopRoutineMenu } from '../../routines/DesktopRoutineMenu'
import { DesktopRoutinesSkeleton } from '../../routines/DesktopRoutinesSkeleton'
import { useDesktopRoutines } from '../../routines/useDesktopRoutines'

const RUN_SETTLE_MS = 1500

export function DesktopWorkspaceRoutines({ client, agentNameOf, onOpenChat, docked, className, active = true, refreshKey, workingSessions = '' }: {
    client: DesktopWorkspaceRoutinesClient
    agentNameOf: (agentId: string) => string
    onOpenChat: (chat: DesktopWorkspaceRoutineChat) => void
    onOpenRoutine?: (routine: DesktopWorkspaceRoutine) => void
    docked: boolean
    className?: string
    active?: boolean
    refreshKey?: string | number
    workingSessions?: string
}) {
    const { t } = useDesktopLocale()
    const [data, setData] = useState<DesktopWorkspaceRoutinesView | null>(null)
    const [loadError, setLoadError] = useState<string | null>(null)
    const [editing, setEditing] = useState<{ routine: DesktopWorkspaceRoutine; externalChange: boolean; generation: number } | null>(null)
    const loaded = useRef(false)
    const listEpoch = useRef(0)
    const previousWorkingSessions = useRef(workingSessions)
    const lifetime = useRef(0)
    useEffect(() => { ++lifetime.current; return () => { ++lifetime.current } }, [client, active])

    const load = useCallback(async () => {
        const own = ++listEpoch.current
        try {
            const next = await client.list()
            if (own !== listEpoch.current) return
            setData(next)
            setLoadError(null)
            setEditing(current => {
                if (!current) return null
                const latest = next.routines.find(routine => routineKey(routine) === routineKey(current.routine))
                return latest?.revision !== current.routine.revision ? { ...current, externalChange: true } : current
            })
        } catch (cause) {
            if (own !== listEpoch.current) return
            setLoadError(cause instanceof Error ? cause.message : t('routines.loadFailed'))
            setData(current => current ?? { routines: [], canRename: false })
        } finally {
            loaded.current = true
        }
    }, [client, t])

    useEffect(() => {
        if (!active) return
        const settle = loaded.current && previousWorkingSessions.current !== workingSessions ? RUN_SETTLE_MS : 0
        previousWorkingSessions.current = workingSessions
        const timer = setTimeout(() => { void load() }, settle)
        const poll = setInterval(() => { void load() }, 2500)
        return () => { listEpoch.current++; clearTimeout(timer); clearInterval(poll) }
    }, [active, refreshKey, workingSessions, load])

    const patch = (key: string, change: Partial<DesktopWorkspaceRoutine>) => setData(current => current && { ...current, routines: current.routines.map(routine => routineKey(routine) === key ? { ...routine, ...change } : routine) })
    // The rows' state and what they do, shared with a coworker's own list (upstream #318).
    const list = useDesktopRoutines({ client, routines: data?.routines ?? null, active, patch, onSaved: patch, reload: load, onOpenChat })
    const { routines: upToDate, now, requestId, runNow } = list

    const openEditor = (routine: DesktopWorkspaceRoutine) => setEditing({ routine, externalChange: false, generation: 0 })
    const openResult = (routine: DesktopWorkspaceRoutine) => {
        if (routine.lastResult?.chat) onOpenChat(routine.lastResult.chat)
        else toast.error(t('routines.noResult'))
    }
    const saveEdit = async (input: DesktopScheduleEditInput) => {
        if (!editing || editing.externalChange) return
        const routine = editing.routine
        const result = await client.mutate({ action: 'edit', agentId: routine.agentId, slug: routine.slug, expectedRevision: routine.revision, requestId: requestId(`edit:${routine.agentId}:${routine.slug}:${JSON.stringify(input)}`, routine.revision), input })
        setEditing(null)
        patch(routineKey(routine), result.routine)
        await load()
    }
    const deleteRoutine = async (routine: DesktopWorkspaceRoutine) => {
        const own = lifetime.current
        const result = await scheduleRequest(routine.agentId, 'DELETE', { slug: routine.slug, expectedRevision: routine.revision })
        if (result?.deleted !== routine.slug) throw new Error(t('routines.requestFailed'))
        if (own !== lifetime.current) return
        ++listEpoch.current
        setEditing(null)
        setData(current => current && { ...current, routines: current.routines.filter(item => routineKey(item) !== routineKey(routine)) })
        await load()
    }

    if (editing) {
        const latest = data?.routines.find(routine => routineKey(routine) === routineKey(editing.routine))
        return <div className={cn('flex flex-col', className)}>
            <DesktopWorkspaceRoutineEditor
                key={`${editing.routine.agentId}:${editing.routine.slug}:${editing.generation}`}
                routine={editing.routine}
                latestResult={latest?.lastResult}
                active={active}
                externalChange={editing.externalChange}
                onBack={() => setEditing(null)}
                onSave={saveEdit}
                onDelete={() => deleteRoutine(editing.routine)}
                onRun={runNow}
                onOpenChat={onOpenChat}
                onRefresh={() => setEditing(latest ? { routine: latest, externalChange: false, generation: editing.generation + 1 } : null)}
                onKeep={latest && (() => setEditing(current => current ? { ...current, routine: latest, externalChange: false } : null))}
            />
        </div>
    }
    if (!upToDate || !data) return <DesktopRoutinesSkeleton className={className} />
    if (loadError && !data.routines.length) return <EmptyState icon={CalendarClockIcon} title={t('routines.unavailable')} description={loadError} className={className} />
    if (!upToDate.length) return <div className={cn('flex flex-col', className)}><EmptyState icon={CalendarClockIcon} title={t('routines.emptyTitle')} description={t('routines.emptyDescription')} /></div>

    return <RoutineList
        routines={upToDate}
        now={now}
        copy={(key, values) => t(`routines.${key}`, values)}
        agentNameOf={agentNameOf}
        onOpen={openEditor}
        onToggle={list.toggle}
        isSaving={list.isSaving}
        renamingKey={list.renamingKey}
        onRename={list.rename}
        onCancelRename={list.cancelRename}
        renderMenu={routine => <DesktopRoutineMenu routine={routine} canRename={data.canRename} onRename={() => list.startRename(routine)} onEdit={() => openEditor(routine)} onRunNow={() => runNow(routine)} onOpenResult={() => openResult(routine)} />}
        docked={docked}
        className={className}
    />
}

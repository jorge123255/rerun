'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { EmptyState } from '@/components/ui/empty-state'
import { Skeleton } from '@/components/ui/skeleton'
import { CalendarClockIcon, EllipsisIcon } from '@/lib/icons'
import { cn } from '@/lib/utils'
import { RoutineList, routineKey } from '@rerun/ui/foreman'
import { nextRunAt, routineFrequency } from '@/lib/schedules/cron'
import type { DesktopWorkspaceRoutinesClient } from '@/lib/desktop/workspace-routines/client'
import { scheduleRequest } from '@/lib/desktop/schedules/client'
import { desktopScheduleSummary } from '@/lib/desktop/schedule-description'
import type { DesktopScheduleEditInput, DesktopWorkspaceRoutine, DesktopWorkspaceRoutineChat, DesktopWorkspaceRoutinesView } from '@rerun/contracts'
import { desktopLocaleTag } from '@/lib/desktop/locale'
import { useDesktopLocale } from '../../DesktopLocale'
import { DesktopWorkspaceRoutineEditor } from './DesktopWorkspaceRoutineEditor'

const RUN_SETTLE_MS = 1500

function useNow(intervalMs: number): number {
    const [now, setNow] = useState(() => Date.now())
    useEffect(() => {
        const id = setInterval(() => setNow(Date.now()), intervalMs)
        return () => clearInterval(id)
    }, [intervalMs])
    return now
}

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
    const { t, language } = useDesktopLocale()
    const locale = desktopLocaleTag(language.locale)
    const [data, setData] = useState<DesktopWorkspaceRoutinesView | null>(null)
    const [loadError, setLoadError] = useState<string | null>(null)
    const [saving, setSaving] = useState<string[]>([])
    const [renamingKey, setRenamingKey] = useState<string | null>(null)
    const [heldNextRuns, setHeldNextRuns] = useState<Record<string, string | null>>({})
    const [editing, setEditing] = useState<{ routine: DesktopWorkspaceRoutine; externalChange: boolean; generation: number } | null>(null)
    const now = useNow(30_000)
    const loaded = useRef(false)
    const listEpoch = useRef(0)
    const previousWorkingSessions = useRef(workingSessions)
    const requestIds = useRef(new Map<string, string>())
    const acting = useRef(new Set<string>())
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

    const upToDate = useMemo(() => {
        if (!data) return null
        const at = new Date(now)
        return data.routines.map(routine => {
            const key = routineKey(routine)
            const held = heldNextRuns[key]
            const stillHeld = key in heldNextRuns && (held === null || new Date(held).getTime() > now)
            const frequency = routine.runAt
                ? desktopScheduleSummary(routine, t, locale)
                : routineFrequency(routine, (key, values) => t(`routines.${key}`, values), locale)
            return { ...routine, frequency, nextRunAt: stillHeld ? held : nextRunAt({ ...routine, lastRunAt: routine.lastRunAt ?? null }, at) }
        })
    }, [data, now, heldNextRuns, locale, t])

    const patch = (key: string, change: Partial<DesktopWorkspaceRoutine>) => setData(current => current && { ...current, routines: current.routines.map(routine => routineKey(routine) === key ? { ...routine, ...change } : routine) })
    const requestId = (action: string, revision: string) => {
        const key = `${action}:${revision}`
        const existing = requestIds.current.get(key)
        if (existing) return existing
        const created = crypto.randomUUID()
        requestIds.current.set(key, created)
        return created
    }

    const toggle = async (routine: DesktopWorkspaceRoutine, enabled: boolean) => {
        const key = routineKey(routine)
        setHeldNextRuns(current => key in current ? current : { ...current, [key]: routine.nextRunAt })
        patch(key, { enabled })
        setSaving(current => [...current, key])
        try {
            const result = await client.mutate({ action: 'toggle', agentId: routine.agentId, slug: routine.slug, expectedRevision: routine.revision, requestId: requestId(`toggle:${routine.agentId}:${routine.slug}:${enabled}`, routine.revision), enabled })
            patch(key, result.routine)
            await load()
        } catch (cause) {
            patch(key, { enabled: !enabled })
            toast.error(t(enabled ? 'routines.resumeFailed' : 'routines.pauseFailed', { name: routine.name }), { description: cause instanceof Error ? cause.message : undefined })
        } finally {
            setSaving(current => current.filter(value => value !== key))
        }
    }

    const rename = async (routine: DesktopWorkspaceRoutine, name: string) => {
        const key = routineKey(routine)
        setRenamingKey(null)
        patch(key, { name })
        try {
            const result = await client.mutate({ action: 'rename', agentId: routine.agentId, slug: routine.slug, expectedRevision: routine.revision, requestId: requestId(`rename:${routine.agentId}:${routine.slug}:${name}`, routine.revision), name })
            patch(key, result.routine)
            await load()
        } catch (cause) {
            patch(key, { name: routine.name })
            toast.error(t('routines.renameFailed', { name: routine.name }), { description: cause instanceof Error ? cause.message : undefined })
        }
    }

    const runNow = async (routine: DesktopWorkspaceRoutine) => {
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
            await load()
        } catch (cause) {
            if (own === lifetime.current) toast.error(t('routines.runFailed', { name: routine.name }), { description: cause instanceof Error ? cause.message : undefined })
        } finally { acting.current.delete(key) }
    }

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
    if (!upToDate || !data) return <RoutinesSkeleton className={className} />
    if (loadError && !data.routines.length) return <EmptyState icon={CalendarClockIcon} title={t('routines.unavailable')} description={loadError} className={className} />
    if (!upToDate.length) return <div className={cn('flex flex-col', className)}><EmptyState icon={CalendarClockIcon} title={t('routines.emptyTitle')} description={t('routines.emptyDescription')} /></div>

    return <RoutineList
        routines={upToDate}
        now={now}
        copy={(key, values) => t(`routines.${key}`, values)}
        agentNameOf={agentNameOf}
        onOpen={openEditor}
        onToggle={toggle}
        isSaving={routine => saving.includes(routineKey(routine))}
        renamingKey={renamingKey}
        onRename={rename}
        onCancelRename={() => setRenamingKey(null)}
        renderMenu={routine => <RoutineMenu routine={routine} canRename={data.canRename} onRename={() => setRenamingKey(routineKey(routine))} onEdit={() => openEditor(routine)} onRunNow={() => runNow(routine)} onOpenResult={() => openResult(routine)} />}
        docked={docked}
        className={className}
    />
}

function RoutineMenu({ routine, canRename, onRename, onEdit, onRunNow, onOpenResult }: { routine: DesktopWorkspaceRoutine; canRename: boolean; onRename: () => void; onEdit: () => void; onRunNow: () => void; onOpenResult: () => void }) {
    const { t } = useDesktopLocale()
    return <DropdownMenu>
        <DropdownMenuTrigger asChild>
            <Button size="icon-sm" variant="ghost" aria-label={t('routines.options', { name: routine.name })} className="text-muted-foreground"><EllipsisIcon /></Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" onCloseAutoFocus={event => event.preventDefault()}>
            {canRename && <DropdownMenuItem onSelect={onRename}>{t('routines.rename')}</DropdownMenuItem>}
            <DropdownMenuItem onSelect={onEdit}>{t('routines.edit')}</DropdownMenuItem>
            <DropdownMenuItem disabled={!routine.lastResult?.chat} onSelect={onOpenResult}>{t('routines.openResult')}</DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem disabled={routine.setupPending && !routine.enabled} onSelect={onRunNow}>{t('routines.runNow')}</DropdownMenuItem>
        </DropdownMenuContent>
    </DropdownMenu>
}

const SKELETON_GROUPS = [{ heading: 'w-14', rows: 2 }, { heading: 'w-20', rows: 3 }]
const TITLE_WIDTHS = ['w-1/2', 'w-2/5', 'w-3/5', 'w-1/3', 'w-1/2']
const RULE_WIDTHS = ['w-3/5', 'w-1/2', 'w-2/3', 'w-2/5', 'w-1/2']
function RoutinesSkeleton({ className }: { className?: string }) {
    let rowIndex = 0
    return <div className={cn('flex flex-col', className)}><div className="min-h-0 flex-1 overflow-hidden px-3 pb-4">
        {SKELETON_GROUPS.map((group, groupIndex) => <section key={groupIndex}>
            <div className={cn('-mx-3 flex items-center px-4 pb-2.5', groupIndex === 0 ? 'pt-2' : 'pt-7')}>
                <div className="flex h-6 items-center gap-2"><Skeleton className={cn('h-4', group.heading)} /><Skeleton className="h-3.5 w-3" /></div>
            </div>
            <div className="divide-y divide-border/70 overflow-hidden rounded-2xl border border-border bg-muted/20">
                {Array.from({ length: group.rows }).map(() => {
                    const i = rowIndex++
                    return <div key={i} className="flex min-h-16 items-center gap-3 px-4 py-3">
                        <Skeleton className="size-7 shrink-0 rounded-md" />
                        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                            <div className="flex h-5 items-center"><Skeleton className={cn('h-3.5', TITLE_WIDTHS[i % TITLE_WIDTHS.length])} /></div>
                            <div className="flex h-4 items-center"><Skeleton className={cn('h-3', RULE_WIDTHS[i % RULE_WIDTHS.length])} /></div>
                        </div>
                        <Skeleton className="h-5 w-9 shrink-0 rounded-full" />
                        <Skeleton className="size-7 shrink-0 rounded-md" />
                    </div>
                })}
            </div>
        </section>)}
    </div></div>
}

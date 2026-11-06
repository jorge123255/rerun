'use client'

import { useEffect, useState } from 'react'
import { RoutineList, type RoutineEntry } from '@rerun/ui/foreman'
import { EmptyState } from '@/components/ui/empty-state'
import { Skeleton } from '@/components/ui/skeleton'
import { CalendarClockIcon } from '@/lib/icons'
import type { DesktopForemanRoutinesPort } from '@/lib/desktop/foreman-client'
import { cn } from '@/lib/utils'

type RoutineRow = RoutineEntry & { runningSessionId?: string | null }

export function DesktopForemanRoutines({
    routines,
    docked,
    className,
    agentNameOf,
    onOpenRoutine,
}: {
    routines: DesktopForemanRoutinesPort
    docked: boolean
    className?: string
    agentNameOf: (agentId: string) => string
    onOpenRoutine?: (routine: RoutineRow) => void
}) {
    const [data, setData] = useState<{ available: boolean; reason?: string; routines: RoutineRow[] } | null>(null)

    useEffect(() => {
        let cancelled = false
        const controller = new AbortController()
        void routines
            .list(controller.signal)
            .then(next => {
                if (cancelled) return
                setData({
                    available: next.available,
                    reason: next.reason,
                    routines: next.routines.map(routine => ({
                        slug: routine.slug,
                        name: routine.name,
                        agentId: routine.agentId,
                        enabled: routine.enabled,
                        frequency: routine.frequency,
                        nextRunAt: routine.nextRunAt,
                        runningSince: null,
                        runningSessionId: routine.runningSessionId ?? null,
                    })),
                })
            })
            .catch(() => {
                if (!cancelled) setData({ available: false, reason: 'Routines could not be loaded.', routines: [] })
            })
        return () => {
            cancelled = true
            controller.abort()
        }
    }, [routines])

    if (!data) {
        return (
            <div className={cn('flex flex-col gap-3 p-4', className)}>
                <Skeleton className="h-10 w-full" />
                <Skeleton className="h-10 w-full" />
            </div>
        )
    }

    if (!data.available) {
        return (
            <EmptyState
                icon={CalendarClockIcon}
                title="Routines unavailable"
                description={data.reason || 'This runtime cannot list schedules yet.'}
                className={className}
            />
        )
    }

    if (!data.routines.length) {
        return (
            <EmptyState
                icon={CalendarClockIcon}
                title="No routines yet"
                description="Schedules created with your coworkers will show up here."
                className={className}
            />
        )
    }

    return (
        <RoutineList
            routines={data.routines}
            now={Date.now()}
            docked={docked}
            className={className}
            agentNameOf={agentNameOf}
            onOpen={routine => onOpenRoutine?.(routine)}
        />
    )
}

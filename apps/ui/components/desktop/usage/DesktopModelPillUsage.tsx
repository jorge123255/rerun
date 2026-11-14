'use client'

import { useEffect, useState, type ReactNode } from 'react'
import type { ConnectionSummary } from '@rerun/contracts'
import { TooltipLabeled } from '@/components/ui/tooltip'
import type { DesktopModelView } from '@/lib/desktop/chat-model'
import { desktopPlanPillUsage } from '@/lib/desktop/plan-limits'
import { planWindowName, planWindowPercent, planWindowReset } from '@/lib/engine/ai-sources'

export function useDesktopModelPillUsage(
    effective: Pick<DesktopModelView['effective'], 'available' | 'connectionId' | 'provider'> | undefined,
    connections: readonly ConnectionSummary[] | undefined,
    active = true,
) {
    const [, refreshUsageClock] = useState(0)
    const connection = active && effective?.available ? connections?.find(item =>
        item.id === effective.connectionId && item.provider === effective.provider && item.connected && !item.credentialRejected) : undefined
    const usage = connection ? desktopPlanPillUsage(connection) : null
    const nextChange = usage?.nextChangeAt
    useEffect(() => {
        if (nextChange === undefined) return
        const timeout = setTimeout(() => refreshUsageClock(value => value + 1), Math.max(1, nextChange - Date.now()))
        return () => clearTimeout(timeout)
    }, [nextChange])
    return usage
}

export function DesktopModelPillUsageTooltip({ usage, children }: {
    usage: ReturnType<typeof desktopPlanPillUsage>
    children: ReactNode
}) {
    if (!usage) return <>{children}</>
    return <TooltipLabeled side="top" label={<ul className="space-y-1">
        {usage.windows.map((window, index) => {
            const reset = planWindowReset(window)
            return <li key={`${window.kind}:${window.label ?? ''}:${index}`}>{planWindowName(window)} {planWindowPercent(window)} used{reset ? `, ${reset}` : ''}</li>
        })}
    </ul>}>{children}</TooltipLabeled>
}

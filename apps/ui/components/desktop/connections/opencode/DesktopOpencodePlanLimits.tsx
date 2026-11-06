'use client'

import { DetailBlock } from '@/components/connections/DetailBlock'
import { PlanLimitMeter } from '@/components/connections/SourceBits'
import { Button } from '@/components/ui/button'
import { shortRelativeTime, shortUntil } from '@/lib/time'
import type { DesktopOpencodeWindow } from '@rerun/contracts'

function readingAge(capturedAt: string | null, fresh: boolean): string {
    if (fresh) return 'Updated just now'
    if (!capturedAt) return 'No live reading'
    const age = shortRelativeTime(capturedAt)
    return age === 'now' ? 'Updated just now' : `Updated ${age} ago`
}

function windowName(kind: DesktopOpencodeWindow['kind']): string {
    return kind === 'session' ? '5-hour' : kind === 'weekly' ? 'Weekly' : 'Monthly'
}

export function DesktopOpencodePlanLimits({ windows, capturedAt, fresh, refreshing = false, onRefresh }: {
    windows: DesktopOpencodeWindow[]
    capturedAt: string | null
    fresh: boolean
    refreshing?: boolean
    onRefresh?: () => void
}) {
    return (
        <DetailBlock
            title="Plan usage"
            aside={<span className="flex items-center gap-2 text-[11px] text-muted-foreground">
                {readingAge(capturedAt, fresh)}
                {onRefresh && <Button type="button" size="xs" variant="ghost" disabled={refreshing} onClick={onRefresh}>{refreshing ? 'Refreshing…' : 'Refresh usage'}</Button>}
            </span>}
        >
            {windows.length === 0 ? (
                <p className="text-[11px] text-muted-foreground">Usage shows up here after the next run on this plan.</p>
            ) : (
                <div className="space-y-3 rounded-md border bg-muted/20 p-3">
                    {windows.map(window => {
                        const name = windowName(window.kind)
                        return (
                            <div key={window.kind} className="space-y-1.5">
                                <div className="flex flex-wrap items-baseline justify-between gap-3 text-xs">
                                    <span className="font-medium">{name}</span>
                                    <span className="text-muted-foreground tabular-nums">
                                        {Math.round(window.usedPercent)}% used{window.resetsAt ? `, resets ${shortUntil(window.resetsAt)}` : ''}
                                    </span>
                                </div>
                                <PlanLimitMeter percent={window.usedPercent} label={`${name} limit used`} />
                            </div>
                        )
                    })}
                </div>
            )}
        </DetailBlock>
    )
}

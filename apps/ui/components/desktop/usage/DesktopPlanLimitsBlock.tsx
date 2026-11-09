'use client'

import { DetailBlock } from '@/components/connections/DetailBlock'
import { PlanLimitMeter } from '@/components/connections/SourceBits'
import { desktopPlanUsage } from '@/lib/desktop/plan-limits'
import { planWindowName, planWindowPercent, planWindowReset } from '@/lib/engine/ai-sources'
import type { BoxConnection } from '@/lib/engine/types'
import { shortRelativeTime } from '@/lib/time'

function readingAge(capturedAt: string): string {
    const age = shortRelativeTime(capturedAt)
    return age === 'now' ? 'Updated just now' : `Updated ${age} ago`
}

export function DesktopPlanLimitsBlock({ connection }: { connection: Pick<BoxConnection, 'provider' | 'planLimits'> }) {
    const usage = desktopPlanUsage(connection)

    if (usage.status === 'unknown') {
        return (
            <DetailBlock title="Plan usage">
                <p className="text-[11px] text-muted-foreground">Usage is unavailable for this ChatGPT account. No usage reading has been recorded.</p>
            </DetailBlock>
        )
    }

    return (
        <DetailBlock title="Plan usage" aside={<span className="text-[11px] text-muted-foreground">{usage.capturedAt ? readingAge(usage.capturedAt) : 'Capture time unavailable'}</span>}>
            <div className="space-y-3 rounded-md border bg-muted/20 p-3">
                {usage.status === 'stale' && <p role="status" className="text-[11px] text-muted-foreground">This usage reading may be stale. Refresh is unavailable in this build.</p>}
                {usage.windows.map((window, index) => {
                    const name = planWindowName(window)
                    const reset = planWindowReset(window)
                    return (
                        <div key={`${window.kind}:${window.label ?? ''}:${index}`} className="space-y-1.5">
                            <div className="flex items-baseline justify-between gap-3 text-xs">
                                <span className="font-medium">{name}</span>
                                <span className="text-muted-foreground tabular-nums">
                                    {planWindowPercent(window)} used{reset ? `, ${reset}` : ''}
                                </span>
                            </div>
                            <PlanLimitMeter percent={window.usedPercent} label={`${name} limit used`} />
                        </div>
                    )
                })}
            </div>
        </DetailBlock>
    )
}

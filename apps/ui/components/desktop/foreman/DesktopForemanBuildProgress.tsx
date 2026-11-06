'use client'

import {
    buildItemLabel,
    projectBuildProgress,
    type DesktopForemanBuildProgressView,
} from '@/lib/desktop/foreman-client'
import { Button } from '@/components/ui/button'
import { PANEL_CARD } from '@/components/ui/panel-row'
import { cn } from '@/lib/utils'

export function DesktopForemanBuildProgress({
    build,
    onOpenCoworker,
    onOpenBox,
}: {
    build: DesktopForemanBuildProgressView
    onOpenCoworker?: (input: { agentId: string; sessionId: string | null }) => void
    onOpenBox?: (spaceId: string) => void
}) {
    const { items, partial, completedCount, failedCount, navigable } = projectBuildProgress(build)

    return (
        <div className={cn('flex flex-col gap-3 p-4', PANEL_CARD)}>
            <div className="flex items-start justify-between gap-2">
                <div>
                    <p className="text-sm font-medium">Building your team</p>
                    <p className="text-xs text-muted-foreground">
                        {completedCount} created
                        {failedCount ? ` · ${failedCount} failed` : ''}
                        {partial ? ' · partial' : ''}
                    </p>
                </div>
                <span className="text-[11px] uppercase tracking-wide text-muted-foreground">{build.status}</span>
            </div>
            <ul className="flex flex-col gap-2">
                {items.map(item => (
                    <li key={item.itemKey} className="flex items-start justify-between gap-3 rounded-lg border border-border/70 px-3 py-2">
                        <div className="min-w-0">
                            <p className="truncate text-sm font-medium">{item.name}</p>
                            <p className="text-xs text-muted-foreground">{buildItemLabel(item)}</p>
                            {item.error && <p className="text-xs text-destructive">{item.error}</p>}
                        </div>
                        {item.status === 'created' && item.agentId && onOpenCoworker && (
                            <Button
                                size="sm"
                                variant="secondary"
                                onClick={() => onOpenCoworker({ agentId: item.agentId!, sessionId: item.sessionId })}
                            >
                                Open
                            </Button>
                        )}
                        {item.status === 'created' && item.boxId && onOpenBox && (
                            <Button size="sm" variant="ghost" onClick={() => onOpenBox(item.boxId!)}>
                                Box
                            </Button>
                        )}
                    </li>
                ))}
            </ul>
            {navigable.length === 0 && build.status === 'running' && (
                <p className="text-xs text-muted-foreground">Coworkers are not started automatically after creation.</p>
            )}
        </div>
    )
}

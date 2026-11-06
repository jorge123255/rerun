'use client'

import { cn } from '@/lib/utils'

export function DesktopDiscoveryStatusPill({
    name,
    found,
    digging,
}: {
    name: string
    found: number
    digging: boolean
}) {
    return (
        <div className={cn('rounded-full border border-border bg-card/95 px-3 py-1 text-[11px] shadow-sm', digging ? 'text-foreground' : 'text-muted-foreground')}>
            {digging ? `Looking into ${name}…` : found ? `Found ${found} thing${found === 1 ? '' : 's'} about ${name}` : `Nothing new about ${name}`}
        </div>
    )
}

'use client'

import type { DesktopCoworkerShareInclude, DesktopCoworkerSharePlan, ShareBucket } from '@rerun/contracts'
import { Field } from '@/components/ui/field'
import { PANEL_CARD } from '@/components/ui/panel-row'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { formatBytes } from '@/lib/files/format'
import { cn } from '@/lib/utils'

function bucketLabel(bucket: ShareBucket, noun: string, empty: string): string {
    if (bucket.count === 0) return empty
    return `${bucket.count} ${noun}${bucket.count === 1 ? '' : 's'} · ${formatBytes(bucket.bytes)}`
}

const CONTAINER = cn(PANEL_CARD, 'divide-y divide-border')
const ROW = 'p-3'

export function DesktopCoworkerShareOptions({ plan, include, onChange, disabled }: {
    plan: DesktopCoworkerSharePlan
    include: DesktopCoworkerShareInclude
    onChange: (next: Partial<DesktopCoworkerShareInclude>) => void
    disabled: boolean
}) {
    const rows = [
        { key: 'memories' as const, label: 'Memories', helper: bucketLabel(plan.contents.memories, 'memory', 'Nothing remembered yet'), value: include.memories },
        { key: 'database' as const, label: 'Coworker database', helper: plan.contents.database.count === 0 ? 'No tables yet' : `${formatBytes(plan.contents.database.bytes)} · not scanned for secrets`, value: include.database },
        { key: 'files' as const, label: 'Workspace files', helper: bucketLabel(plan.contents.files, 'file', 'No files yet'), value: include.files },
    ]
    return <div className={CONTAINER}>
        {rows.map(row => <Field key={row.key} orientation="row" label={row.label} helperText={plan.unavailable?.[row.key] ?? row.helper} className={ROW}>
            <Switch checked={!plan.unavailable?.[row.key] && row.value} disabled={disabled || !!plan.unavailable?.[row.key]} onCheckedChange={checked => onChange({ [row.key]: checked })} aria-label={row.label} />
        </Field>)}
    </div>
}

export function DesktopCoworkerShareOptionsSkeleton() {
    return <div className={CONTAINER}>
        {['memories', 'database', 'files'].map(key => <div key={key} className={cn(ROW, 'flex items-center justify-between gap-4')}>
            <div className="flex flex-col gap-1.5"><Skeleton className="h-3 w-28" /><Skeleton className="h-3 w-40" /></div>
            <Skeleton className="h-5 w-9 rounded-full" />
        </div>)}
    </div>
}

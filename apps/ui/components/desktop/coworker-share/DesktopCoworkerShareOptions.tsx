'use client'

import type { DesktopCoworkerShareInclude, DesktopCoworkerSharePlan, ShareBucket } from '@rerun/contracts'
import { Field } from '@/components/ui/field'
import { PANEL_CARD } from '@/components/ui/panel-row'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { sectionTransferReady, type DesktopCoworkerShareSectionReadiness } from '@/lib/desktop/coworker-share/sections'
import { formatBytes } from '@/lib/files/format'
import { cn } from '@/lib/utils'

function bucketLabel(bucket: ShareBucket, noun: string, empty: string): string {
    if (bucket.count === 0) return empty
    return `${bucket.count} ${noun}${bucket.count === 1 ? '' : 's'} · ${formatBytes(bucket.bytes)}`
}

const CONTAINER = cn(PANEL_CARD, 'divide-y divide-border')
const ROW = 'p-3'

export function DesktopCoworkerShareOptions({ plan, include, onChange, disabled, sections }: {
    plan: DesktopCoworkerSharePlan
    include: DesktopCoworkerShareInclude
    onChange: (next: Partial<DesktopCoworkerShareInclude>) => void
    disabled: boolean
    sections?: { memories: DesktopCoworkerShareSectionReadiness; database: DesktopCoworkerShareSectionReadiness }
}) {
    const memories = sections?.memories ?? sectionTransferReady('memories', plan.unavailable?.memories, null)
    const database = sections?.database ?? sectionTransferReady('database', plan.unavailable?.database, null)
    const filesReason = plan.unavailable?.files
    const rows = [
        { key: 'memories' as const, label: 'Memories', helper: memories.reason ?? bucketLabel(memories.contents, 'memory', 'Nothing remembered yet'), value: include.memories, enabled: memories.enabled },
        { key: 'database' as const, label: 'Coworker database', helper: database.reason ?? (database.contents.count === 0 ? 'No tables yet' : `${formatBytes(database.contents.bytes)} · not scanned for secrets`), value: include.database, enabled: database.enabled },
        { key: 'files' as const, label: 'Workspace files', helper: filesReason ?? bucketLabel(plan.contents.files, 'file', 'No files yet'), value: include.files, enabled: !filesReason },
    ]
    return <div className={CONTAINER}>
        {rows.map(row => <Field key={row.key} orientation="row" label={row.label} helperText={row.helper} className={ROW}>
            <Switch checked={row.enabled && row.value} disabled={disabled || !row.enabled} onCheckedChange={checked => onChange({ [row.key]: checked })} aria-label={row.label} />
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

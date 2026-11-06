'use client'

import { useMemo, useState } from 'react'
import { DetailBlock } from '@/components/connections/DetailBlock'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { TooltipLabeled } from '@/components/ui/tooltip'
import { SearchIcon, StarIcon } from '@/lib/icons'
import { shortRelativeTime } from '@/lib/time'
import { cn } from '@/lib/utils'
import { desktopOpencodeModelRows, desktopOpencodePlanOf, type DesktopOpencodeModel, type DesktopOpencodeModelRow, type DesktopOpencodePlan, type DesktopOpencodeRefresh } from '@rerun/contracts'
import { Badge } from '@rerun/ui/primitives'

const SECTIONS: { plan: DesktopOpencodePlan; title: string; hint: string }[] = [
    { plan: 'go', title: 'Included in OpenCode Go', hint: 'Paid by your Go plan, within its 5-hour, weekly and monthly limits.' },
    { plan: 'console', title: 'Console, paid with your credits', hint: 'Billed per token from your OpenCode credits. Off until you switch one on.' },
]

export type DesktopOpencodeModelsChange = { enabledModelIds: string[]; consoleEnabled: boolean }

function pricePerMillion(price: NonNullable<DesktopOpencodeModelRow['price']>): string {
    const usd = (value: number) => `$${Number(value.toFixed(3))}`
    return `${usd(price.input)} in · ${usd(price.output)} out /M`
}

function ModelRow({ row, model, isDefault, lockReason, disabled, onToggle }: { row: DesktopOpencodeModelRow; model?: DesktopOpencodeModel; isDefault: boolean; lockReason?: string; disabled?: boolean; onToggle: (on: boolean) => void }) {
    const toggle = <Switch checked={row.enabled} disabled={disabled || !!lockReason} onCheckedChange={onToggle} aria-label={row.enabled ? `Turn off ${row.label}` : `Turn on ${row.label}`} />
    return (
        <li className={cn('flex min-h-11 items-center gap-3 px-3 py-2', !row.enabled && 'text-muted-foreground')}>
            <div className="flex min-w-0 flex-1 flex-col gap-1">
                <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                    <span className={cn('truncate text-xs font-medium', row.enabled && 'text-foreground')}>{row.label}</span>
                    {isDefault && <StarIcon aria-label="Default model" className="size-3 shrink-0 text-yellow-400 [&_polygon]:fill-current" />}
                    <Badge size="xs" tone={row.plan === 'go' ? 'green' : 'cyan'} className="shrink-0">{row.plan === 'go' ? 'Included' : 'Credits'}</Badge>
                    {row.isNew && <Badge size="xs" tone="brand" className="shrink-0">New</Badge>}
                    {model && !model.images && <Badge size="xs" tone="neutral" className="shrink-0">No vision</Badge>}
                </div>
                {(row.retired || (row.plan === 'console' && row.price)) && <span className="truncate text-[11px] text-muted-foreground">{row.retired ? 'No longer offered by OpenCode' : pricePerMillion(row.price!)}</span>}
            </div>
            {lockReason ? <TooltipLabeled label={lockReason}>{toggle}</TooltipLabeled> : toggle}
        </li>
    )
}

function matches(row: DesktopOpencodeModelRow, query: string): boolean {
    if (!query) return true
    const needle = query.toLowerCase()
    return row.label.toLowerCase().includes(needle) || row.id.toLowerCase().includes(needle)
}

export function DesktopOpencodeModels({ catalog, enabledModelIds, defaultModelId, consoleEnabled, disabled = false, refreshing = false, onRefresh, onModelsChange }: {
    catalog: DesktopOpencodeRefresh
    enabledModelIds: string[]
    defaultModelId: string
    consoleEnabled: boolean
    disabled?: boolean
    refreshing?: boolean
    onRefresh?: () => void
    onModelsChange: (change: DesktopOpencodeModelsChange) => void
}) {
    const [query, setQuery] = useState('')
    const rows = useMemo(() => desktopOpencodeModelRows({ models: catalog.models, source: catalog.source, enabledModelIds, consoleEnabled }), [catalog, enabledModelIds, consoleEnabled])
    const models = useMemo(() => new Map(catalog.models.map(model => [model.id, model])), [catalog.models])
    const enabledCount = rows.filter(row => row.enabled).length
    const trimmed = query.trim()
    const firstConsole = rows.find(row => row.plan === 'console' && !row.retired)

    const lockReason = (row: DesktopOpencodeModelRow): string | undefined => {
        if (row.locked) return row.lockReason
        if (row.id === defaultModelId && row.enabled) return 'This is the default model. Pick another default first.'
        if (row.enabled && enabledCount === 1) return 'Coworkers need at least one model from this source.'
        return undefined
    }
    const toggle = (row: DesktopOpencodeModelRow, on: boolean) => {
        if (on === row.enabled || disabled || lockReason(row)) return
        onModelsChange({ enabledModelIds: on ? [...enabledModelIds, row.id] : enabledModelIds.filter(id => id !== row.id), consoleEnabled })
    }
    const toggleConsole = (on: boolean) => {
        if (disabled) return
        if (on && firstConsole) onModelsChange({ enabledModelIds: [...new Set([...enabledModelIds, firstConsole.id])], consoleEnabled: true })
        if (!on) onModelsChange({ enabledModelIds: enabledModelIds.filter(id => desktopOpencodePlanOf(id) !== 'console'), consoleEnabled: false })
    }

    const catalogAge = catalog.source === 'snapshot'
        ? 'Bundled model snapshot'
        : catalog.fresh
            ? 'Updated just now'
            : catalog.capturedAt
                ? `${shortRelativeTime(catalog.capturedAt) === 'now' ? 'Updated just now' : `Updated ${shortRelativeTime(catalog.capturedAt)} ago`}${catalog.source === 'cached' ? ' · cached' : ''}`
                : `Cached model data${catalog.source === 'cached' ? ' · cached' : ''}`

    return (
        <div className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-[11px] text-muted-foreground">{catalogAge}</span>
                {onRefresh && <Button type="button" size="xs" variant="outline" disabled={disabled || refreshing} onClick={onRefresh}>{refreshing ? 'Refreshing…' : 'Refresh models'}</Button>}
            </div>
            {catalog.unavailableReason && <p className="text-[11px] text-muted-foreground">{catalog.unavailableReason}</p>}
            {!catalog.selectedPreserved && <p className="text-[11px] text-muted-foreground">The selected model is not in this catalog and was not replaced.</p>}
            <div className="relative">
                <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input aria-label="Search models" value={query} onChange={event => setQuery(event.target.value)} placeholder="Search models" className="h-8 pl-8 text-xs" />
            </div>
            {SECTIONS.map(section => {
                const inPlan = rows.filter(row => row.plan === section.plan)
                const shown = inPlan.filter(row => matches(row, trimmed))
                if (trimmed && shown.length === 0) return null
                return (
                    <DetailBlock
                        key={section.plan}
                        title={section.title}
                        aside={<span className="flex items-center gap-2 text-[11px] text-muted-foreground tabular-nums">
                            {section.plan === 'console' && <Switch checked={consoleEnabled} disabled={disabled || !firstConsole} onCheckedChange={toggleConsole} aria-label="Use OpenCode Console credits" />}
                            {inPlan.filter(row => row.enabled).length} of {inPlan.length} on
                        </span>}
                    >
                        <p className="text-[11px] text-muted-foreground">{section.hint}</p>
                        {shown.length === 0 ? (
                            <p className="rounded-md border border-dashed px-3 py-2.5 text-[11px] text-muted-foreground">OpenCode lists no model here right now.</p>
                        ) : (
                            <ul className="divide-y rounded-md border bg-muted/20">
                                {shown.map(row => <ModelRow key={row.id} row={row} model={models.get(row.id)} isDefault={row.id === defaultModelId} lockReason={lockReason(row)} disabled={disabled} onToggle={on => toggle(row, on)} />)}
                            </ul>
                        )}
                    </DetailBlock>
                )
            })}
            {trimmed && rows.every(row => !matches(row, trimmed)) && <p className="text-[11px] text-muted-foreground">No model matches “{trimmed}”.</p>}
        </div>
    )
}

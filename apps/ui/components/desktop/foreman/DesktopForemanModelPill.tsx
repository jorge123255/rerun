'use client'

import { useId, useState } from 'react'
import type { ConnectionSummary, DesktopForemanModelRef } from '@rerun/contracts'
import { UsageRing } from '@/components/agent/UsageRing'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import type { DesktopModelView } from '@/lib/desktop/chat-model'
import { ProviderIcon } from '@/lib/engine/provider-icons'
import { CheckIcon, ChevronDownIcon } from '@/lib/icons'
import { useDesktopLocale } from '../DesktopLocale'
import { DesktopModelPillUsageTooltip, useDesktopModelPillUsage } from '../usage/DesktopModelPillUsage'

export function DesktopForemanModelPill({ view, connections, disabled, saving, onPick, onSettings }: {
    view: DesktopModelView
    connections?: readonly ConnectionSummary[]
    disabled: boolean
    saving: boolean
    onPick(model: DesktopForemanModelRef | null): Promise<void>
    onSettings?: () => void
}) {
    const { t } = useDesktopLocale()
    const [open, setOpen] = useState(false)
    const [error, setError] = useState<string>()
    const titleId = useId()
    const { effective, conversation } = view
    const usage = useDesktopModelPillUsage(effective, connections)
    const label = !effective.model ? t('foreman.modelPicker.setUp') : effective.source === 'workspace'
        ? t('foreman.modelPicker.defaultLabel', { model: effective.label }) : effective.label
    const pick = async (model: DesktopForemanModelRef | null) => {
        setError(undefined)
        try { await onPick(model); setOpen(false) }
        catch (cause) { setError(cause instanceof Error ? cause.message : t('creation.tryAgain')) }
    }
    return <Popover open={open} onOpenChange={next => { setOpen(next); if (next) setError(undefined) }}>
        <DesktopModelPillUsageTooltip usage={usage}>
            <PopoverTrigger asChild>
                <Button type="button" variant="ghost" size="sm" disabled={(disabled || saving) && !open} className="min-w-0 max-w-full gap-1 text-xs"
                    aria-label={`${t('foreman.modelPicker.select')} · ${label}${usage ? ` · ${usage.label}` : ''}`}>
                    {usage ? <UsageRing usage={usage}><ProviderIcon provider={effective.provider} /></UsageRing>
                        : <ProviderIcon provider={effective.provider} className="size-3.5 shrink-0" />}
                    <span className="truncate">{label}</span><ChevronDownIcon aria-hidden className="size-3 shrink-0" />
                </Button>
            </PopoverTrigger>
        </DesktopModelPillUsageTooltip>
        <PopoverContent align="start" collisionPadding={12} aria-labelledby={titleId} className="w-72 max-w-[calc(100vw-1.5rem)] gap-2 overflow-hidden p-2">
            <h2 id={titleId} className="px-2 pt-1 text-sm font-semibold">{t('foreman.modelPicker.select')}</h2>
            {error && <p role="alert" className="px-2 text-xs text-destructive">{error}</p>}
            {effective.model && !effective.available && <p className="px-2 text-xs text-muted-foreground">{t('foreman.modelUnavailable')}</p>}
            <div className="max-h-[min(420px,50dvh)] overflow-y-auto">
                <button type="button" disabled={disabled || saving || !conversation} aria-current={!conversation || undefined}
                    className="flex min-h-11 w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm hover:bg-muted/40" onClick={() => void pick(null)}>
                    <span className="min-w-0 flex-1">
                        <span className="block">{t('foreman.modelPicker.workspaceDefault')}</span>
                        {view.workspace && <span className="block truncate text-xs text-muted-foreground">{view.workspace.name} · {view.workspace.label}</span>}
                    </span>
                    {!conversation && <CheckIcon aria-hidden className="size-4" />}
                </button>
                {view.catalog.length === 0 && <p className="px-2.5 py-2 text-xs text-muted-foreground">{t('foreman.modelPicker.empty')}</p>}
                {view.catalog.map(group => <div key={group.connectionId}>
                    <p className="px-2.5 pb-1 pt-2 text-[11px] font-medium text-muted-foreground">{group.name}</p>
                    {group.models.map(model => {
                        const chosen = conversation?.connectionId === group.connectionId && conversation.model === model.id
                        return <button key={model.id} type="button" disabled={disabled || saving || chosen} aria-current={chosen || undefined}
                            className="flex min-h-11 w-full items-center justify-between gap-2 rounded-lg px-2.5 py-2 text-left text-sm hover:bg-muted/40"
                            onClick={() => void pick({ connectionId: group.connectionId, model: model.id })}>
                            <span className="truncate">{model.label}</span>{chosen && <CheckIcon aria-hidden className="size-4" />}
                        </button>
                    })}
                </div>)}
            </div>
            {onSettings && <Button type="button" size="sm" variant="ghost" className="justify-start" disabled={saving}
                onClick={() => { setOpen(false); onSettings() }}>{t('settings')}</Button>}
        </PopoverContent>
    </Popover>
}

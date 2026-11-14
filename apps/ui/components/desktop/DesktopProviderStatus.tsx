'use client'

import { useState } from 'react'
import { Cpu } from 'lucide-react'
import { PROVIDER_LABELS, type BoxDefaultModel, type ConnectionSummary, type Provider } from '@rerun/contracts'
import { PlanLimitMeter } from '@/components/connections/SourceBits'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { ProviderIcon } from '@/lib/engine/provider-icons'
import { planWindowName, planWindowPercent, planWindowReset } from '@/lib/engine/ai-sources'
import { ChevronDownIcon } from '@/lib/icons'
import { desktopConnectionModelLabel } from '@/lib/desktop/chat-model'
import { desktopPlanUsage } from '@/lib/desktop/plan-limits'
import { useDesktopLocale } from './DesktopLocale'

const labelOf = (connection: Pick<ConnectionSummary, 'provider' | 'name'>) =>
    connection.provider in PROVIDER_LABELS ? PROVIDER_LABELS[connection.provider as Provider] : connection.name

/**
 * The provider pill of the board's header. It names the workspace default as before and opens a
 * list of every connected provider with the usage each one reports.
 */
export function DesktopProviderStatus({ providerLabel, modelLabel, connections = [], workspaceDefault, disabled, onSettings }: {
    providerLabel?: string
    modelLabel?: string
    connections?: readonly ConnectionSummary[]
    workspaceDefault?: BoxDefaultModel | null
    disabled?: boolean
    onSettings(): void
}) {
    const { t } = useDesktopLocale()
    const [open, setOpen] = useState(false)
    const connected = connections.filter(connection => connection.connected && !connection.credentialRejected)
    const providerStatus = providerLabel ? t('boardUI.providerConnected', { provider: providerLabel }) : t('boardUI.providerSetup')
    const providerSummary = providerLabel && modelLabel ? `${providerStatus} · ${modelLabel}` : providerStatus
    const others = connected.length > 1 ? ` · ${connected.length} connected` : ''
    return <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
            <Button type="button" variant="outline" size="sm" disabled={disabled && !open}
                aria-keyshortcuts="Meta+," title={t('boardUI.modelSettings')} aria-label={providerSummary + others}
                className="pointer-events-auto relative h-8 min-w-0 rounded-full bg-background/90 px-2.5 text-xs backdrop-blur-xl @max-md/board-header:size-8 @max-md/board-header:shrink-0 @max-md/board-header:p-0">
                <Cpu aria-hidden className="hidden @max-md/board-header:block" />
                <span role={providerLabel ? 'status' : undefined} className="flex min-w-0 items-center gap-1.5 @max-md/board-header:sr-only">
                    {providerLabel && <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-emerald-500" />}
                    <span className="truncate">{providerStatus}</span>
                    {providerLabel && modelLabel && <span className="max-w-36 truncate text-muted-foreground">{modelLabel}</span>}
                    {connected.length > 1 && <span className="shrink-0 rounded-full bg-muted px-1.5 text-[10px] text-muted-foreground" aria-hidden>+{connected.length - 1}</span>}
                    <ChevronDownIcon aria-hidden className="size-3 shrink-0 text-muted-foreground" />
                </span>
                {providerLabel && <span aria-hidden className="absolute top-1 right-1 hidden size-1.5 rounded-full bg-emerald-500 @max-md/board-header:block" />}
            </Button>
        </PopoverTrigger>
        <PopoverContent align="start" collisionPadding={12} data-testid="desktop-provider-status" className="max-h-[var(--radix-popover-content-available-height)] w-80 max-w-[calc(100vw-1.5rem)] gap-2 overflow-y-auto p-2">
            <h2 className="px-2 pt-1 text-sm font-semibold">Connected providers</h2>
            {connected.length === 0 && <p className="px-2 text-xs text-muted-foreground">{t('boardUI.providerSetup')}</p>}
            <ul className="space-y-1.5">
                {connected.map(connection => {
                    const isDefault = workspaceDefault?.connectionId === connection.id
                    const usage = desktopPlanUsage(connection)
                    return <li key={connection.id} data-provider={connection.provider} className="rounded-lg border border-border p-2.5">
                        <div className="flex items-center gap-2">
                            <ProviderIcon provider={connection.provider} className="size-4 shrink-0" />
                            <span className="min-w-0 flex-1 truncate text-sm font-medium">{connection.name || labelOf(connection)}</span>
                            <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-emerald-500" />
                        </div>
                        <p className="mt-0.5 truncate text-xs text-muted-foreground">
                            {isDefault && workspaceDefault ? `Workspace default · ${desktopConnectionModelLabel(connection, workspaceDefault.model)}`
                                : `${connection.models.length + (connection.extraModels?.length ?? 0)} ${connection.models.length + (connection.extraModels?.length ?? 0) === 1 ? 'model' : 'models'}`}
                        </p>
                        {usage.status === 'unknown'
                            ? <p className="mt-1.5 text-[11px] text-muted-foreground">{usage.reason === 'unsupported-provider' ? 'This provider does not report usage.' : 'No usage reading yet.'}</p>
                            : <div className="mt-2 space-y-2">
                                {usage.windows.map((window, index) => {
                                    const name = planWindowName(window), reset = planWindowReset(window)
                                    return <div key={`${window.kind}:${window.label ?? ''}:${index}`} className="space-y-1">
                                        <div className="flex items-baseline justify-between gap-3 text-[11px]">
                                            <span className="font-medium">{name}</span>
                                            <span className="text-muted-foreground tabular-nums">{planWindowPercent(window)} used{reset ? `, ${reset}` : ''}</span>
                                        </div>
                                        <PlanLimitMeter percent={window.usedPercent} label={`${connection.name} ${name} limit used`} />
                                    </div>
                                })}
                                {usage.status === 'stale' && <p className="text-[11px] text-muted-foreground">This reading may be out of date.</p>}
                            </div>}
                    </li>
                })}
            </ul>
            <Button type="button" size="sm" variant="ghost" className="justify-start" disabled={disabled} onClick={() => { setOpen(false); onSettings() }}>{t('boardUI.modelSettings')}</Button>
        </PopoverContent>
    </Popover>
}

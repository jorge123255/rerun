'use client'

import { useCallback, useEffect, useId, useRef, useState } from 'react'
import type { BoxDefaultModel, ConnectionSummary } from '@rerun/contracts'
import { ChevronDown, Settings2, Star } from 'lucide-react'
import { DotSpinner } from '@/components/ui/dot-spinner'
import { UsageRing } from '@/components/agent/UsageRing'
import { DesktopModelPillUsageTooltip, useDesktopModelPillUsage } from './usage/DesktopModelPillUsage'
import { ProviderIcon } from '@/lib/engine/provider-icons'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { desktopModelViewSchema, type DesktopModelPick, type DesktopModelView } from '@/lib/desktop/chat-model'
import { cn } from '@/lib/utils'
import { useDesktopLocale } from './DesktopLocale'

export type DesktopModelBlock = 'setup' | 'unavailable' | 'reasoning'

type Props = {
    agentId: string
    sessionId: string | null
    disabled?: boolean
    active?: boolean
    connections?: ConnectionSummary[]
    workspaceDefault?: BoxDefaultModel | null
    onOpenSettings?: () => void
    onConversationChoice?: (choice: DesktopModelPick | undefined) => void
    onReady?: (ready: boolean) => void
    onBlocked?: (reason: DesktopModelBlock | null) => void
    openRequest?: number
}

function modelUrl(agentId: string, sessionId: string | null) {
    const base = `/api/desktop/agents/${encodeURIComponent(agentId)}/model`
    return sessionId ? `${base}?sessionId=${encodeURIComponent(sessionId)}` : base
}

async function readState(response: Response): Promise<DesktopModelView> {
    const body = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(typeof body.error === 'string' ? body.error : 'Could not load models')
    const parsed = desktopModelViewSchema.safeParse(body)
    if (!parsed.success) throw new Error('Could not load models')
    return parsed.data
}

export function DesktopModelSelector(props: Props) {
    // A response for a chat that was closed or replaced must only settle its own picker.
    return <ChatModelMenu key={JSON.stringify([props.agentId, props.sessionId])} {...props} />
}

function ChatModelMenu({ agentId, sessionId, disabled, active = true, connections, workspaceDefault, onOpenSettings, onConversationChoice, onReady, onBlocked, openRequest }: Props) {
    const { t } = useDesktopLocale()
    const [open, setOpen] = useState(false)
    const [state, setState] = useState<DesktopModelView | null>(null)
    const [pending, setPending] = useState<DesktopModelPick | null>(null)
    const [error, setError] = useState<string>()
    const [saving, setSaving] = useState(false)
    const titleId = useId()
    const descriptionId = useId()
    const reported = useRef<string | null>(null)
    const handledOpen = useRef(openRequest)
    const version = useRef(0)
    const current = state
    // The board polls Settings, including quota updates. Only model-affecting changes need a fresh
    // conversation read. The server still resolves the saved choice and exact workspace default.
    const catalogKey = JSON.stringify([
        workspaceDefault?.connectionId, workspaceDefault?.model, workspaceDefault?.reasoningEffort, workspaceDefault?.customReasoningRevision,
        connections?.map(connection => [connection.id, connection.provider, connection.name, connection.connected, connection.credentialRejected,
            connection.models, connection.extraModels, connection.customRevision, connection.customReasoning,
            connection.codexReasoning, connection.subscriptionModels, connection.opencodeModels]),
    ])
    useEffect(() => {
        if (!active || openRequest === handledOpen.current) return
        handledOpen.current = openRequest
        setOpen(true)
    }, [active, openRequest])

    const load = useCallback(async (signal?: AbortSignal) => {
        const response = await fetch(modelUrl(agentId, sessionId), { signal, cache: 'no-store' })
        return readState(response)
    }, [agentId, sessionId])

    useEffect(() => {
        if (!active) return
        const started = version.current
        const controller = new AbortController()
        void load(controller.signal).then(next => {
            if (controller.signal.aborted || started !== version.current) return
            setState(next)
            setError(undefined)
        }).catch(cause => {
            if (!controller.signal.aborted && started === version.current) setError(cause instanceof Error ? cause.message : 'Could not load models')
        })
        return () => controller.abort()
    }, [load, active, open, catalogKey])

    const conversation = pending ?? (current?.conversation ? { connectionId: current.conversation.connectionId, model: current.conversation.model } : undefined)
    useEffect(() => {
        if (!current && !pending) return
        const key = conversation ? `${conversation.connectionId}\0${conversation.model}` : ''
        if (reported.current === key) return
        reported.current = key
        onConversationChoice?.(conversation)
    }, [conversation, current, onConversationChoice, pending])

    async function save(body: Record<string, unknown>, nextPending: DesktopModelPick | null) {
        version.current++
        setSaving(true)
        setError(undefined)
        try {
            const response = await fetch(modelUrl(agentId, sessionId), { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
            const next = await readState(response)
            version.current++
            setState(next)
            setPending(sessionId ? null : nextPending)
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : 'Could not save this model')
        } finally {
            setSaving(false)
        }
    }

    const pendingGroup = pending && current?.catalog.find(group => group.connectionId === pending.connectionId)
    const pendingModel = pendingGroup && pendingGroup.models.find(model => model.id === pending.model)
    const effective = pending ? {
        source: 'conversation' as const,
        connectionId: pending.connectionId,
        provider: pendingGroup?.provider ?? null,
        name: pendingGroup?.name,
        model: pending.model,
        label: pendingModel?.label ?? pending.model,
        available: !!pendingModel,
        reasoningUnavailable: !!current?.effective.reasoningUnavailable
            && pending.connectionId === current.workspace?.connectionId && pending.model === current.workspace.model,
    } : current?.effective
    const setupRequired = !!current && !current.workspace
    const blocked = setupRequired ? 'setup' : effective?.reasoningUnavailable ? 'reasoning'
        : effective?.model && !effective.available ? 'unavailable' : null
    const ready = !!effective?.available && !blocked && !saving && !error
    useEffect(() => { onReady?.(ready) }, [ready, onReady])
    useEffect(() => { onBlocked?.(blocked) }, [blocked, onBlocked])
    const busy = disabled || saving
    const usage = useDesktopModelPillUsage(effective, connections, active)
    const sourceLabel = effective && t(effective.source === 'workspace' ? 'modelPicker.workspaceDefault'
        : effective.source === 'coworker' ? 'modelPicker.coworkerDefault' : 'modelPicker.conversation')
    const label = !effective?.model ? t('modelPicker.select') : effective.available
        ? `${effective.name ?? t('modelPicker.select')} · ${effective.label}`
        : t('modelPicker.unavailable', { model: effective.label })

    if (!current && !error) return <span role="status" className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground">
        <DotSpinner variant="light" size="xs" /> {t('modelPicker.loading')}
    </span>

    if (setupRequired && onOpenSettings && !effective?.model && !open && !error) return (
        <Button type="button" size="sm" variant="ghost" className="min-w-0 gap-1 text-xs text-destructive" disabled={busy}
            onClick={onOpenSettings}>
            <span className="truncate">{t('modelPicker.setUp')}</span><Settings2 aria-hidden className="size-3 shrink-0" />
        </Button>
    )

    const trigger = (
        <PopoverTrigger asChild>
            <Button type="button" size="sm" variant="ghost" className={cn('min-w-0 gap-1 text-xs', blocked && 'text-destructive')} disabled={busy && !open}
                aria-label={[label, sourceLabel, usage?.label].filter(Boolean).join(' · ')}>
                {usage ? <UsageRing usage={usage}><ProviderIcon provider={effective?.provider} /></UsageRing>
                    : <ProviderIcon provider={effective?.provider} className="size-3.5 shrink-0" />}
                <span className="truncate">{label}</span><ChevronDown aria-hidden className="size-3 shrink-0" />
            </Button>
        </PopoverTrigger>
    )

    return (
        <Popover open={open} onOpenChange={setOpen}>
            <DesktopModelPillUsageTooltip usage={usage}>{trigger}</DesktopModelPillUsageTooltip>
            <PopoverContent align="start" collisionPadding={12} aria-labelledby={titleId} aria-describedby={descriptionId} className="max-h-[var(--radix-popover-content-available-height)] w-80 max-w-[calc(100vw-1.5rem)] gap-2 overflow-hidden p-2">
                <div className="px-2 pt-1">
                    <h2 id={titleId} className="text-sm font-semibold">{t('modelPicker.select')}</h2>
                    <p id={descriptionId} className="mt-1 text-xs text-muted-foreground">{t('modelPicker.scope')}</p>
                </div>
                {error && <p role="alert" className="px-2 text-xs text-destructive">{error}</p>}
                <div className="max-h-[min(420px,50dvh)] overflow-y-auto">
                    {setupRequired && <p className="px-2.5 py-2 text-xs text-muted-foreground">{t('modelPicker.workspaceRequired')}</p>}
                    {current?.catalog.length === 0 && <p className="px-2.5 py-2 text-xs text-muted-foreground">{t('modelPicker.empty')}</p>}
                    {current?.workspace && <button type="button" className="flex min-h-11 w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left hover:bg-muted/40" disabled={busy}
                        aria-current={effective?.source === 'workspace' ? 'true' : undefined}
                        onClick={() => void save({ action: 'follow-workspace', ...(sessionId && { sessionId }) }, null)}>
                        <span className="min-w-0 flex-1">
                            <span className="block text-sm font-medium">{t('modelPicker.workspaceDefault')}</span>
                            <span className="block truncate text-xs text-muted-foreground">{current.workspace.name} · {current.workspace.label}</span>
                        </span>
                    </button>}
                    {current?.coworker && <button type="button" className="flex min-h-11 w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left hover:bg-muted/40" disabled={busy || !sessionId && !pending}
                        aria-current={effective?.source === 'coworker' ? 'true' : undefined}
                        onClick={() => sessionId ? void save({ action: 'conversation-follow', sessionId }, null) : setPending(null)}>
                        <span className="min-w-0 flex-1">
                            <span className="block text-sm font-medium">{t('modelPicker.coworkerDefault')}</span>
                            <span className="block truncate text-xs text-muted-foreground">{current.coworker.available ? current.coworker.label : t('modelPicker.unavailable', { model: current.coworker.label })}</span>
                        </span>
                        <Star aria-hidden className="size-3.5 fill-current text-primary" />
                    </button>}
                    {current?.catalog.map(group => (
                        <div key={group.connectionId} className="pt-1">
                            <p className="px-2.5 pb-1 pt-2 text-[11px] font-medium text-muted-foreground">{group.name}</p>
                            {group.models.map(model => {
                                const picked = effective?.connectionId === group.connectionId && effective.model === model.id
                                const pinned = current.coworker?.connectionId === group.connectionId && current.coworker.model === model.id
                                const choice = { connectionId: group.connectionId, model: model.id }
                                return (
                                    <div key={model.id} className={cn('flex min-h-11 items-center rounded-lg hover:bg-muted/40', picked && 'bg-muted/60')}>
                                        <button type="button" className="min-w-0 flex-1 px-2.5 py-2 text-left text-sm" disabled={busy} aria-current={picked ? 'true' : undefined}
                                            onClick={() => sessionId ? void save({ action: 'conversation', sessionId, ...choice }, null) : setPending(choice)}>
                                            {model.label}
                                        </button>
                                        {pinned ? <span className="px-2" aria-label={t('modelPicker.coworkerPin', { model: model.label })}><Star aria-hidden className="size-3.5 fill-current text-primary" /></span>
                                            : <button type="button" className="px-2 text-muted-foreground hover:text-foreground" disabled={busy} aria-label={t('modelPicker.makeDefault', { model: model.label })}
                                                onClick={() => void save({ action: 'coworker', ...choice, ...(sessionId && { sessionId }) }, pending)}>
                                                <Star aria-hidden className="size-3.5" />
                                            </button>}
                                    </div>
                                )
                            })}
                        </div>
                    ))}
                    {current && effective?.model && !effective.available && <p className="px-2.5 py-2 text-xs text-muted-foreground">{t('modelPicker.savedUnavailable')}</p>}
                    {!pending && current?.effective.reasoning && <p className="px-2.5 py-2 text-xs text-muted-foreground">{current.effective.reasoning.source === 'workspace' ? `Reasoning effort ${current.effective.reasoning.effort} from the workspace default.` : `Reasoning effort ${current.effective.reasoning.effort}, this model’s default.`}</p>}
                    {effective?.reasoningUnavailable && <p className="px-2.5 py-2 text-xs text-muted-foreground">The saved reasoning effort needs review in model settings.</p>}
                </div>
                {onOpenSettings && <Button type="button" size="sm" variant="ghost" className="justify-start" onClick={() => { setOpen(false); onOpenSettings() }}>{t('modelPicker.manage')}</Button>}
            </PopoverContent>
        </Popover>
    )
}

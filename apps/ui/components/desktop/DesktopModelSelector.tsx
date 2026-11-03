'use client'

import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { ChevronDown, Star } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { desktopModelViewSchema, MODEL_SOURCE_LABEL, type DesktopModelPick, type DesktopModelView } from '@/lib/desktop/chat-model'
import { cn } from '@/lib/utils'

type Props = {
    agentId: string
    sessionId: string | null
    disabled?: boolean
    active?: boolean
    workspaceModel?: string
    onOpenSettings?: () => void
    onConversationChoice?: (choice: DesktopModelPick | undefined) => void
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

function ChatModelMenu({ agentId, sessionId, disabled, active = true, workspaceModel, onOpenSettings, onConversationChoice }: Props) {
    const [open, setOpen] = useState(false)
    const [state, setState] = useState<DesktopModelView | null>(null)
    const [pending, setPending] = useState<DesktopModelPick | null>(null)
    const [error, setError] = useState<string>()
    const [saving, setSaving] = useState(false)
    const titleId = useId()
    const descriptionId = useId()
    const reported = useRef<string | null>(null)
    const version = useRef(0)
    const current = state

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
    }, [load, active, open])

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

    const view = current && pending ? {
        ...current,
        conversation: { connectionId: pending.connectionId, model: pending.model, label: current.catalog.flatMap(group => group.models).find(model => model.id === pending.model)?.label ?? pending.model, available: true },
        effective: {
            source: 'conversation' as const,
            connectionId: pending.connectionId,
            provider: current.catalog.find(group => group.connectionId === pending.connectionId)?.provider ?? null,
            name: current.catalog.find(group => group.connectionId === pending.connectionId)?.name ?? null,
            model: pending.model,
            label: current.catalog.flatMap(group => group.models).find(model => model.id === pending.model)?.label ?? pending.model,
            available: current.catalog.some(group => group.connectionId === pending.connectionId && group.models.some(model => model.id === pending.model)),
        },
    } : current
    const effective = view?.effective
    const label = !effective?.model ? (workspaceModel ? `Default · ${workspaceModel}` : 'Choose model') : effective.available ? `${effective.name ?? 'Model'} · ${effective.label}` : `Unavailable · ${effective.label}`
    const busy = disabled || saving

    return (
        <Popover open={open} onOpenChange={setOpen}>
            <PopoverTrigger asChild>
                <Button type="button" size="sm" variant="ghost" className="min-w-0 gap-1 text-xs" disabled={busy && !open} aria-label={effective ? `Model for this chat: ${label}. ${MODEL_SOURCE_LABEL[effective.source]}.` : 'Choose a model for this chat'}>
                    <span className="truncate">{label}</span><ChevronDown aria-hidden className="size-3" />
                </Button>
            </PopoverTrigger>
            <PopoverContent align="start" collisionPadding={12} aria-labelledby={titleId} aria-describedby={descriptionId} className="max-h-[var(--radix-popover-content-available-height)] w-80 max-w-[calc(100vw-1.5rem)] gap-2 overflow-hidden p-2">
                <div className="px-2 pt-1">
                    <h2 id={titleId} className="text-sm font-semibold">Model</h2>
                    <p id={descriptionId} className="mt-1 text-xs text-muted-foreground">Choosing a model changes only this chat. The star sets this coworker’s default.</p>
                </div>
                {error && <p className="px-2 text-xs text-destructive">{error}</p>}
                <div className="max-h-[min(420px,50dvh)] overflow-y-auto">
                    {view?.workspace && <button type="button" className="flex min-h-11 w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left hover:bg-muted/40" disabled={busy}
                        aria-current={effective?.source === 'workspace' ? 'true' : undefined}
                        onClick={() => void save({ action: 'follow-workspace', ...(sessionId && { sessionId }) }, null)}>
                        <span className="min-w-0 flex-1">
                            <span className="block text-sm font-medium">Workspace default</span>
                            <span className="block truncate text-xs text-muted-foreground">{view.workspace.name} · {view.workspace.label}</span>
                        </span>
                    </button>}
                    {view?.coworker && <button type="button" className="flex min-h-11 w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left hover:bg-muted/40" disabled={busy || !sessionId && !pending}
                        aria-current={effective?.source === 'coworker' ? 'true' : undefined}
                        onClick={() => sessionId ? void save({ action: 'conversation-follow', sessionId }, null) : setPending(null)}>
                        <span className="min-w-0 flex-1">
                            <span className="block text-sm font-medium">Coworker default</span>
                            <span className="block truncate text-xs text-muted-foreground">{view.coworker.available ? view.coworker.label : `Unavailable · ${view.coworker.label}`}</span>
                        </span>
                        <Star aria-hidden className="size-3.5 fill-current text-primary" />
                    </button>}
                    {view?.catalog.map(group => (
                        <div key={group.connectionId} className="pt-1">
                            <p className="px-2.5 pb-1 pt-2 text-[11px] font-medium text-muted-foreground">{group.name}</p>
                            {group.models.map(model => {
                                const picked = effective?.connectionId === group.connectionId && effective.model === model.id
                                const pinned = view.coworker?.connectionId === group.connectionId && view.coworker.model === model.id
                                const choice = { connectionId: group.connectionId, model: model.id }
                                return (
                                    <div key={model.id} className={cn('flex min-h-11 items-center rounded-lg hover:bg-muted/40', picked && 'bg-muted/60')}>
                                        <button type="button" className="min-w-0 flex-1 px-2.5 py-2 text-left text-sm" disabled={busy} aria-current={picked ? 'true' : undefined}
                                            onClick={() => sessionId ? void save({ action: 'conversation', sessionId, ...choice }, null) : setPending(choice)}>
                                            {model.label}
                                        </button>
                                        {pinned ? <span className="px-2" aria-label={`${model.label} is this coworker’s default`}><Star aria-hidden className="size-3.5 fill-current text-primary" /></span>
                                            : <button type="button" className="px-2 text-muted-foreground hover:text-foreground" disabled={busy} aria-label={`Make ${model.label} this coworker’s default`}
                                                onClick={() => void save({ action: 'coworker', ...choice, ...(sessionId && { sessionId }) }, pending)}>
                                                <Star aria-hidden className="size-3.5" />
                                            </button>}
                                    </div>
                                )
                            })}
                        </div>
                    ))}
                    {view && effective?.model && !effective.available && <p className="px-2.5 py-2 text-xs text-muted-foreground">This saved model is no longer offered by a connected provider. Choose another, or follow the coworker or workspace default.</p>}
                    {view?.effective.reasoning && <p className="px-2.5 py-2 text-xs text-muted-foreground">{view.effective.reasoning.source === 'workspace' ? `Reasoning effort ${view.effective.reasoning.effort} from the workspace default.` : `Reasoning effort ${view.effective.reasoning.effort}, this model’s default.`}</p>}
                </div>
                {onOpenSettings && <Button type="button" size="sm" variant="ghost" className="justify-start" onClick={() => { setOpen(false); onOpenSettings() }}>Open model settings</Button>}
            </PopoverContent>
        </Popover>
    )
}

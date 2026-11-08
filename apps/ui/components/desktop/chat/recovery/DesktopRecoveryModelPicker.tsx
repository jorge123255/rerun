'use client'

import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { desktopModelViewSchema, type DesktopModelPick, type DesktopModelView } from '@/lib/desktop/chat-model'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { ChevronDown } from 'lucide-react'

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

export function DesktopRecoveryModelPicker({ agentId, sessionId, disabled, onPicked, onSaved, onOpenSettings }: {
    agentId: string
    sessionId: string | null
    disabled?: boolean
    onPicked?: (pick: DesktopModelPick | undefined) => void
    onSaved?: () => void
    onOpenSettings?: () => void
}) {
    const [open, setOpen] = useState(false)
    const [state, setState] = useState<DesktopModelView | null>(null)
    const [error, setError] = useState<string>()
    const [saving, setSaving] = useState(false)
    const titleId = useId()
    const version = useRef(0)

    const load = useCallback(async (signal?: AbortSignal) => {
        const response = await fetch(modelUrl(agentId, sessionId), { signal, cache: 'no-store' })
        return readState(response)
    }, [agentId, sessionId])

    useEffect(() => {
        if (!open) return
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
    }, [load, open])

    async function save(body: Record<string, unknown>, picked: DesktopModelPick | undefined) {
        version.current++
        setSaving(true)
        setError(undefined)
        try {
            if (!sessionId && body.action !== 'follow-workspace') {
                onPicked?.(picked)
                onSaved?.()
                setOpen(false)
                return
            }
            const response = await fetch(modelUrl(agentId, sessionId), { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
            const next = await readState(response)
            version.current++
            setState(next)
            setOpen(false)
            onSaved?.()
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : 'Could not save this model')
        } finally {
            setSaving(false)
        }
    }

    const effective = state?.effective
    const busy = disabled || saving

    return (
        <Popover open={open} onOpenChange={setOpen}>
            <PopoverTrigger asChild>
                <Button type="button" size="sm" variant="outline" className="gap-1" disabled={busy && !open}>
                    Switch model<ChevronDown aria-hidden className="size-3" />
                </Button>
            </PopoverTrigger>
            <PopoverContent align="start" collisionPadding={12} aria-labelledby={titleId} className="max-h-[var(--radix-popover-content-available-height)] w-80 max-w-[calc(100vw-1.5rem)] gap-2 overflow-hidden p-2">
                <div className="px-2 pt-1">
                    <h2 id={titleId} className="text-sm font-semibold">Choose a model</h2>
                    <p className="mt-1 text-xs text-muted-foreground">Choosing a model changes only this chat.</p>
                </div>
                {error && <p className="px-2 text-xs text-destructive">{error}</p>}
                <div className="max-h-[min(420px,50dvh)] overflow-y-auto">
                    {state?.workspace && <button type="button" className="flex min-h-11 w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left hover:bg-muted/40" disabled={busy}
                        onClick={() => void save({ action: 'follow-workspace', sessionId: sessionId ?? undefined }, undefined)}>
                        <span className="min-w-0 flex-1">
                            <span className="block text-sm font-medium">Workspace default</span>
                            <span className="block truncate text-xs text-muted-foreground">{state.workspace.name} · {state.workspace.label}</span>
                        </span>
                    </button>}
                    {state?.coworker && <button type="button" className="flex min-h-11 w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left hover:bg-muted/40" disabled={busy}
                        onClick={() => { if (sessionId) void save({ action: 'conversation-follow', sessionId }, undefined); else { onPicked?.(undefined); onSaved?.(); setOpen(false) } }}>
                        <span className="min-w-0 flex-1">
                            <span className="block text-sm font-medium">Coworker default</span>
                            <span className="block truncate text-xs text-muted-foreground">{state.coworker.available ? state.coworker.label : `Unavailable · ${state.coworker.label}`}</span>
                        </span>
                    </button>}
                    {state?.catalog.map(group => (
                        <div key={group.connectionId} className="pt-1">
                            <p className="px-2.5 pb-1 pt-2 text-[11px] font-medium text-muted-foreground">{group.name}</p>
                            {group.models.map(model => {
                                const picked = effective?.connectionId === group.connectionId && effective.model === model.id
                                const choice = { connectionId: group.connectionId, model: model.id }
                                return (
                                    <button key={model.id} type="button" className="flex min-h-11 w-full items-center rounded-lg px-2.5 py-2 text-left text-sm hover:bg-muted/40" disabled={busy}
                                        aria-current={picked ? 'true' : undefined}
                                        onClick={() => void save({ action: 'conversation', sessionId, ...choice }, choice)}>
                                        {model.label}
                                    </button>
                                )
                            })}
                        </div>
                    ))}
                    {state && effective?.model && !effective.available && <p className="px-2.5 py-2 text-xs text-muted-foreground">This saved model is no longer offered by a connected provider. Choose another, or follow the coworker or workspace default.</p>}
                </div>
                {onOpenSettings && <Button type="button" size="sm" variant="ghost" className="justify-start" onClick={() => { setOpen(false); onOpenSettings() }}>Open model settings</Button>}
            </PopoverContent>
        </Popover>
    )
}

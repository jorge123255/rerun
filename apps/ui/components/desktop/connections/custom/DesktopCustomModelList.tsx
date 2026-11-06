'use client'

import { DetailBlock } from '@/components/connections/DetailBlock'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { CUSTOM_MODEL_HINT, DEFAULT_LOCK, LAST_MODEL_LOCK, RETIRED_MODEL, parseWindow } from '@/lib/desktop/custom-providers'
import { PlusIcon, SearchIcon, StarIcon } from '@/lib/icons'
import type { CustomProviderModel, CustomProviderSnapshot } from '@rerun/contracts'
import { useState } from 'react'
import { useForm } from 'react-hook-form'

type Props = {
    selected: CustomProviderModel[]
    catalog: CustomProviderModel[]
    catalogStatus: CustomProviderSnapshot['catalog']['status']
    connectionVision: boolean
    defaultModelId: string | null
    missingDefault: boolean
    onTurnOff: (id: string) => void
    onTurnOn: (id: string) => void
    onAdd: (id: string) => void
    onWindow: (id: string, value: number | null) => void
    onVision: (id: string, value: boolean) => void
}

function matches(id: string, query: string): boolean {
    return !query || id.toLowerCase().includes(query.toLowerCase())
}

function lockReason(model: CustomProviderModel, selected: CustomProviderModel[], defaultModelId: string | null): string | undefined {
    if (model.id === defaultModelId) return DEFAULT_LOCK
    if (selected.length === 1) return LAST_MODEL_LOCK
    return undefined
}

function retired(model: CustomProviderModel, catalog: CustomProviderModel[], status: Props['catalogStatus']): boolean {
    if (model.source !== 'discovered' || (status !== 'fresh' && status !== 'empty')) return false
    return !catalog.some(row => row.id === model.id)
}

function ModelRow({ model, connectionVision, reason, gone, onTurnOff, onWindow, onVision }: { model: CustomProviderModel; connectionVision: boolean; reason?: string; gone: boolean; onTurnOff: () => void; onWindow: (value: number | null) => void; onVision: (value: boolean) => void }) {
    const [windowText, setWindowText] = useState(model.contextWindow ? String(model.contextWindow) : '')
    const seesImages = connectionVision || model.vision
    return (
        <div className="flex min-w-0 items-start justify-between gap-2 py-1.5">
            <div className="min-w-0 flex-1">
                <div className="flex min-w-0 items-center gap-1.5">
                    <span className="truncate font-mono text-xs">{model.id}</span>
                    {reason === DEFAULT_LOCK && <StarIcon aria-label="Default model" className="size-3.5 shrink-0 text-yellow-400 [&_polygon]:fill-current" />}
                    {!seesImages && <span className="shrink-0 text-[11px] text-muted-foreground">No vision</span>}
                </div>
                <p className="text-[11px] text-muted-foreground">{model.contextWindow ? `${model.contextWindow.toLocaleString('en-US')} tokens` : 'The server does not size this model'}</p>
                {reason && <p className="text-[11px] text-muted-foreground">{reason}</p>}
                {gone && <p className="text-[11px] text-muted-foreground">{RETIRED_MODEL}</p>}
                {model.source === 'manual' && (
                    <div className="mt-1 flex flex-wrap items-center gap-2">
                        <Input aria-label={`Context window for ${model.id}`} hideRequired value={windowText} onChange={event => setWindowText(event.target.value)} onBlur={() => { const next = parseWindow(windowText); if (next !== undefined) onWindow(next) }} inputMode="numeric" placeholder="Context window" className="h-8 max-w-40 font-mono text-xs" />
                        <Switch checked={model.vision} onCheckedChange={onVision} aria-label={`Models see images: ${model.id}`} />
                    </div>
                )}
            </div>
            {!reason && <button type="button" onClick={onTurnOff} aria-label={`Turn off ${model.id}`} className="shrink-0 text-xs text-destructive">Remove</button>}
        </div>
    )
}

export function DesktopCustomModelList(props: Props) {
    const [query, setQuery] = useState('')
    const [adding, setAdding] = useState(false)
    const form = useForm<{ draft: string }>({ defaultValues: { draft: '' } })
    const draft = form.watch('draft')
    const trimmed = query.trim()
    const selected = props.selected.filter(model => matches(model.id, trimmed))
    const hidden = props.catalog.filter(model => !props.selected.some(row => row.id === model.id) && matches(model.id, trimmed))
    const reserved = [...props.selected.map(model => model.id), ...props.catalog.map(model => model.id)]
    const submit = form.handleSubmit(({ draft: value }) => {
        const next = value.trim()
        if (!next || reserved.includes(next)) return
        props.onAdd(next)
        form.reset({ draft: '' })
    })
    return (
        <div className="space-y-4">
            <div className="relative">
                <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input aria-label="Search models" value={query} onChange={event => setQuery(event.target.value)} placeholder="Search models" className="h-8 pl-8 text-xs" />
            </div>
            {props.missingDefault && <p className="text-[11px] text-muted-foreground">{RETIRED_MODEL}</p>}
            {(selected.length > 0 || !trimmed) && (
                <DetailBlock title="Your coworkers can use" aside={<span className="text-[11px] text-muted-foreground">{props.selected.length} of {props.selected.length + props.catalog.filter(model => !props.selected.some(row => row.id === model.id)).length}</span>}>
                    {selected.length === 0 ? <p className="rounded-md border px-3 py-2 text-[11px] text-muted-foreground">Drag a model here so coworkers can use it.</p> : (
                        <div className="space-y-0.5">{selected.map(model => <ModelRow key={model.id} model={model} connectionVision={props.connectionVision} reason={lockReason(model, props.selected, props.defaultModelId)} gone={retired(model, props.catalog, props.catalogStatus)} onTurnOff={() => props.onTurnOff(model.id)} onWindow={value => props.onWindow(model.id, value)} onVision={value => props.onVision(model.id, value)} />)}</div>
                    )}
                </DetailBlock>
            )}
            {(hidden.length > 0 || !trimmed) && (
                <DetailBlock title="Turned off">
                    {hidden.length === 0 ? <p className="rounded-md border border-dashed px-3 py-2 text-[11px] text-muted-foreground">Drag a model here to keep coworkers off it.</p> : (
                        <div className="space-y-0.5">{hidden.map(model => (
                            <div key={model.id} className="flex min-w-0 items-center justify-between gap-2 py-1.5 text-muted-foreground">
                                <span className="truncate font-mono text-xs">{model.id}</span>
                                <button type="button" className="shrink-0 text-xs" aria-label={`Turn on ${model.id}`} onClick={() => props.onTurnOn(model.id)}>Turn on</button>
                            </div>
                        ))}</div>
                    )}
                </DetailBlock>
            )}
            {trimmed && selected.length === 0 && hidden.length === 0 && <p className="text-[11px] text-muted-foreground">No model matches “{trimmed}”.</p>}
            <div className="space-y-2 border-t pt-3">
                {adding ? (
                    <div className="space-y-2">
                        <p className="text-[11px] text-muted-foreground">{CUSTOM_MODEL_HINT} (e.g. <span className="font-mono">llama3.3:70b</span>).</p>
                        <form onSubmit={submit} className="flex items-center gap-2">
                            <div className="min-w-0 flex-1"><Input hideRequired autoFocus placeholder="model id" className="h-8 font-mono text-xs" {...form.register('draft')} /></div>
                            <Button type="submit" size="sm" variant="outline" disabled={!draft.trim()}>Add</Button>
                        </form>
                    </div>
                ) : (
                    <Button type="button" size="sm" variant="outline" onClick={() => setAdding(true)} className="w-full gap-1.5"><PlusIcon className="size-3.5" />Add custom model</Button>
                )}
            </div>
        </div>
    )
}

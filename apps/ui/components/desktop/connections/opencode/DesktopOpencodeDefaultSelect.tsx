'use client'

import { useState } from 'react'
import { isFreeDesktopOpencodeModel, type DesktopOpencodeRefresh } from '@rerun/contracts'
import type { DesktopOpencodeConnectionSnapshot, DesktopOpencodeDefaultPurpose } from '@/lib/desktop/opencode/driver'

export function DesktopOpencodeDefaultSelect({ connection, catalog, modelId, purpose, disabled = false, onChange }: {
    connection: DesktopOpencodeConnectionSnapshot | null
    catalog: DesktopOpencodeRefresh | null
    modelId: string | null
    purpose: DesktopOpencodeDefaultPurpose
    disabled?: boolean
    onChange: (purpose: DesktopOpencodeDefaultPurpose, connectionId: string, modelId: string, expectedConnectionRevision?: string) => Promise<void>
}) {
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const enabled = connection?.enabledModelIds ?? []
    const selected = modelId && enabled.includes(modelId) ? modelId : ''
    const models = new Map(catalog?.models.map(model => [model.id, model]))
    const options = enabled.map(id => {
        const model = models.get(id)
        const label = model?.label ?? id
        return {
            id, label: model && isFreeDesktopOpencodeModel(model.price) ? `${label} · Free` : label,
            retired: catalog?.source === 'live' && !model,
        }
    })
    const unavailable = modelId && (!selected || options.find(option => option.id === modelId)?.retired)
    return (
        <div className="space-y-1.5">
            <label htmlFor={`desktop-opencode-default-${purpose}`} className="text-sm font-medium">{purpose === 'sidebar' ? 'Default model' : `${purpose} model`}</label>
            <select
                id={`desktop-opencode-default-${purpose}`}
                aria-label={purpose === 'sidebar' ? 'Default model' : `${purpose} model`}
                className="w-full rounded-md border bg-background px-3 py-2 text-sm"
                disabled={disabled || busy || !connection || connection.state !== 'active' || !options.length}
                value={selected}
                onChange={event => {
                    const next = event.target.value
                    if (!next || !connection) return
                    setBusy(true)
                    setError(null)
                    void onChange(purpose, connection.connectionId, next, connection.connectionRevision).catch(cause => { if (cause instanceof Error) setError(cause.message) }).finally(() => setBusy(false))
                }}
            >
                {!selected && <option value="" disabled>{options.length ? 'Choose a model' : 'Connect OpenCode to choose a model'}</option>}
                {options.map(option => <option key={option.id} value={option.id}>{option.label}{option.retired ? ' · unavailable' : ''}</option>)}
            </select>
            {unavailable && <p className="text-[11px] text-muted-foreground">The selected model is unavailable and was not replaced.</p>}
            {error && <p role="alert" className="text-[11px] text-destructive">{error}</p>}
        </div>
    )
}

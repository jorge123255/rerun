'use client'

import { useEffect, useState } from 'react'
import type { DesktopBackupModelView } from '@/lib/desktop/server/usage-gate-model'
import { DesktopBackupModel } from './DesktopBackupModel'

type View = { tier: string | null; presets: { id: string; label: string; runsOn: string | null }[]; backup?: DesktopBackupModelView }

/**
 * The workspace default as a Rerun preset. A preset is not one model: each message goes to the
 * first of the owner's own plans that can answer it, and moves to the next when that one is out of
 * usage. The model chosen above stays as the fallback. Routines follow the preset too.
 */
export function DesktopDefaultPreset({ onChanged }: { onChanged?: () => void }) {
    const [view, setView] = useState<View | null>(null)
    const [saving, setSaving] = useState(false)
    const [error, setError] = useState('')
    useEffect(() => {
        const controller = new AbortController()
        void fetch('/api/desktop/settings/default-preset', { cache: 'no-store', signal: controller.signal })
            .then(async response => { if (response.ok && !controller.signal.aborted) setView(await response.json() as View) }).catch(() => {})
        return () => controller.abort()
    }, [])
    if (!view) return null
    const available = view.presets.filter(preset => preset.runsOn)
    const chosen = view.presets.find(preset => preset.id === view.tier)
    const save = async (tier: string | null) => {
        setSaving(true); setError('')
        try {
            const response = await fetch('/api/desktop/settings/default-preset', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tier }) })
            if (!response.ok) throw new Error()
            setView(await response.json() as View)
            onChanged?.()
        } catch { setError('The preset could not be saved. Try again.') } finally { setSaving(false) }
    }
    return <><div className="space-y-2 pt-3">
        <label htmlFor="desktop-default-preset" className="font-semibold">Rerun preset</label>
        <p className="text-sm text-muted-foreground">Let the default follow a preset instead of one model. Each message runs on the first of your plans that has usage left; the model above is the fallback. Routines follow the preset too.</p>
        <select id="desktop-default-preset" className="w-full rounded-md border bg-background px-3 py-2 text-sm" disabled={saving || (!available.length && !view.tier)} value={view.tier ?? ''}
            onChange={event => void save(event.target.value || null)}>
            <option value="">No preset: use the model above</option>
            {view.presets.map(preset => <option key={preset.id} value={preset.id} disabled={!preset.runsOn && preset.id !== view.tier}>
                {preset.label}{preset.runsOn ? ` · now ${preset.runsOn}` : ' · no plan available'}
            </option>)}
        </select>
        {chosen && !chosen.runsOn && <p role="status" className="text-xs text-muted-foreground">No plan can run {chosen.label} right now, so the model above is answering.</p>}
        {!available.length && !view.tier && <p className="text-xs text-muted-foreground">Presets need a ChatGPT or Claude plan, or an OpenAI, Anthropic or OpenRouter key.</p>}
        {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
    </div>
    {view.backup && <DesktopBackupModel initial={view.backup} />}</>
}

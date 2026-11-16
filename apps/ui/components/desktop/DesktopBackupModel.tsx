'use client'

import { useState } from 'react'
import type { DesktopBackupModelView } from '@/lib/desktop/server/usage-gate-model'

type View = DesktopBackupModelView
const ROUTE = '/api/desktop/settings/backup-model'

/**
 * The workspace's backup model. When a plan runs out, routines and chat messages wait for it to
 * reset. With a backup chosen here they run on it instead. A plan is only used while it has usage
 * left. A key is billed per token, and choosing one here is the owner's decision to pay for that.
 */
export function DesktopBackupModel({ initial }: { initial: DesktopBackupModelView }) {
    const [view, setView] = useState<View>(initial)
    const [saving, setSaving] = useState(false)
    const [error, setError] = useState('')
    const value = view.backup ? JSON.stringify([view.backup.connectionId, view.backup.model]) : ''
    const chosen = view.options.find(option => option.connectionId === view.backup?.connectionId)
    const known = !!chosen?.models.some(model => model.id === view.backup?.model)
    const save = async (next: string) => {
        setSaving(true); setError('')
        try {
            const pair = next ? JSON.parse(next) as [string, string] : null
            const response = await fetch(ROUTE, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ backup: pair ? { connectionId: pair[0], model: pair[1] } : null }) })
            if (!response.ok) throw new Error()
            setView(await response.json() as View)
        } catch { setError('The backup model could not be saved. Try again.') } finally { setSaving(false) }
    }
    return <div className="space-y-2 pt-3">
        <label htmlFor="desktop-backup-model" className="font-semibold">Backup model</label>
        <p className="text-sm text-muted-foreground">Optional. When a plan runs out of usage, routines and messages wait for it to reset. Choose a backup and they run on it instead. A plan is used only while it has usage left. A key is billed per token: choosing one here means you agree to pay for what runs on it.</p>
        <select id="desktop-backup-model" className="w-full rounded-md border bg-background px-3 py-2 text-sm" disabled={saving} value={value} onChange={event => void save(event.target.value)}>
            <option value="">No backup: wait for the plan to reset</option>
            {view.backup && !known && <option value={value} disabled>Saved backup is no longer available</option>}
            {view.options.map(option => <optgroup key={option.connectionId} label={`${option.name} · ${option.plan ? 'monthly plan' : 'billed per token or local'}`}>
                {option.models.map(model => <option key={model.id} value={JSON.stringify([option.connectionId, model.id])}>{model.label}</option>)}
            </optgroup>)}
        </select>
        {chosen && known && <p role="status" className="text-xs text-muted-foreground">{chosen.plan
            ? `${chosen.name} is a monthly plan. It is used as the backup only while it has usage left.`
            : `${chosen.name} is not a monthly plan. If it is a key, work that runs on it is billed per token.`}</p>}
        {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
    </div>
}

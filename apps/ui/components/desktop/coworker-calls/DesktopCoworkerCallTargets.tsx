'use client'

import { useEffect, useState } from 'react'
import { z } from 'zod'
import { desktopCoworkerCallTargetSchema } from '@rerun/contracts'
import { Checkbox } from '@/components/ui/checkbox'
import { Button } from '@/components/ui/button'

const viewSchema = z.strictObject({ targets: z.array(desktopCoworkerCallTargetSchema), allowedTargetIds: z.array(z.string()) })
type View = z.infer<typeof viewSchema>

type TargetScope = { agentId: string } | { foreman: { workspaceId: string; chatId: string; launchNonce: string } }

export function DesktopCoworkerCallTargets(scope: TargetScope) {
    const [view, setView] = useState<View | null>(null)
    const [error, setError] = useState('')
    const [saving, setSaving] = useState(false)
    const [attempt, setAttempt] = useState(0)
    const url = 'foreman' in scope
        ? `/api/desktop/foreman/call-targets?${new URLSearchParams(scope.foreman)}`
        : `/api/desktop/coworkers/${encodeURIComponent(scope.agentId)}/call-targets`
    useEffect(() => {
        const controller = new AbortController()
        void fetch(url, { cache: 'no-store', signal: controller.signal }).then(async response => {
            if (!response.ok) throw new Error('Could not load allowed coworkers.')
            const next = viewSchema.parse(await response.json())
            if (!controller.signal.aborted) setView(next)
        }).catch(() => { if (!controller.signal.aborted) setError('Could not load allowed coworkers.') })
        return () => controller.abort()
    }, [url, attempt])
    async function toggle(id: string, enabled: boolean) {
        if (!view || saving) return
        setSaving(true); setError('')
        try {
            const targetAgentIds = enabled ? [...view.allowedTargetIds, id] : view.allowedTargetIds.filter(target => target !== id)
            const response = await fetch(url, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ targetAgentIds, expectedTargetAgentIds: view.allowedTargetIds }) })
            if (!response.ok) throw new Error('Could not save allowed coworkers. Reload and try again.')
            setView(viewSchema.parse(await response.json()))
        } catch { setError('Could not save allowed coworkers. Reload and try again.') }
        finally { setSaving(false) }
    }
    return <div className="mt-2 space-y-2 border-t border-border pt-2">
        <p className="text-xs font-medium">Allowed coworkers</p>
        {!view && !error && <p role="status" className="text-xs text-muted-foreground">Loading coworkers…</p>}
        {view?.targets.map(target => <label key={target.agentId} className="flex min-w-0 items-center gap-2 py-1 text-sm">
            <Checkbox checked={view.allowedTargetIds.includes(target.agentId)} disabled={saving || !target.enabled && !view.allowedTargetIds.includes(target.agentId)} onCheckedChange={checked => { void toggle(target.agentId, checked === true) }} />
            <span className="min-w-0 break-words">{target.name}{target.boxName && <span className="text-xs text-muted-foreground"> · {target.boxName}</span>}{!target.enabled && <span className="text-xs text-muted-foreground"> · Disabled</span>}</span>
        </label>)}
        {view?.targets.length === 0 && <p className="text-xs text-muted-foreground">Add another coworker to allow calls.</p>}
        {error && <div role="alert" className="space-y-1 text-xs text-destructive"><p>{error}</p><Button type="button" variant="outline" size="sm" disabled={saving} onClick={() => { setError(''); setAttempt(n => n + 1) }}>Reload coworkers</Button></div>}
    </div>
}

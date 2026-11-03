'use client'

import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { Icon } from '@/components/ui/icon'
import { PanelGrid, PanelListHeader } from '@/components/ui/panel-list'
import { PANEL_CARD } from '@/components/ui/panel-row'
import { Switch } from '@/components/ui/switch'
import type { DesktopCoworkerSettings } from '@/lib/desktop/coworker-settings'
import { FolderIcon } from '@/lib/icons'
import { cn } from '@/lib/utils'
import type { DesktopAgentView } from './DesktopApp'

async function readSwitch(url: string, init: RequestInit): Promise<boolean> {
    const response = await fetch(url, init)
    if (!response.ok) {
        const error = await response.json().catch(() => ({}))
        throw new Error(typeof error.error === 'string' ? error.error : 'Could not reach this coworker’s tools.')
    }
    const settings: DesktopCoworkerSettings = await response.json()
    return settings.workspaceReadEnabled
}

// One capability card from AgentPanelTools, using the Mac coworker’s own engine settings.
function WorkspaceTools({ agent, saving, setSaving }: { agent: DesktopAgentView; saving: boolean; setSaving: (value: boolean) => void }) {
    const url = `/api/desktop/agents/${encodeURIComponent(agent.id)}/settings`
    const [enabled, setEnabled] = useState<boolean | null>(null)
    const [error, setError] = useState('')
    const [attempt, setAttempt] = useState(0)

    useEffect(() => {
        const controller = new AbortController()
        void readSwitch(url, { cache: 'no-store', signal: controller.signal }).then(value => {
            if (!controller.signal.aborted) setEnabled(value)
        }).catch(cause => {
            if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : 'Could not load tools.')
        })
        return () => controller.abort()
    }, [url, attempt])

    async function toggle(value: boolean) {
        if (saving || enabled === null) return
        setSaving(true)
        setError('')
        try {
            setEnabled(await readSwitch(url, {
                method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ workspaceReadEnabled: value }),
            }))
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : 'Could not save this permission.')
        } finally { setSaving(false) }
    }

    return <>
        <PanelListHeader count={1} noun="capability" />
        {enabled !== null ? <PanelGrid className="grid-cols-1 sm:grid-cols-2">
            <div className={cn('flex flex-col gap-2 p-3', PANEL_CARD)}>
                <div className="flex items-start justify-between gap-2">
                    <Icon icon={FolderIcon} size="md" />
                    <Switch id="desktop-workspace-read" checked={enabled} disabled={saving} onCheckedChange={toggle}
                        aria-describedby="desktop-workspace-read-info" />
                </div>
                <div>
                    <label htmlFor="desktop-workspace-read" className="text-sm font-medium">Read workspace files</label>
                    <p id="desktop-workspace-read-info" className="text-xs text-muted-foreground">Read text files in this coworker’s workspace to answer in chat. File contents are sent to the selected model.</p>
                </div>
            </div>
        </PanelGrid> : !error && <p role="status" className="text-sm text-muted-foreground">Loading tools…</p>}
        {error && <div role="alert" className="space-y-2 text-sm text-destructive">{error}
            {enabled === null && <Button type="button" variant="outline" size="sm" onClick={() => { setError(''); setAttempt(n => n + 1) }}>Retry</Button>}
        </div>}
    </>
}

export function DesktopCoworkerTools({ agent }: { agent: DesktopAgentView }) {
    const [open, setOpen] = useState(false)
    const [saving, setSaving] = useState(false)
    return <Dialog open={open} onOpenChange={next => { if (!saving) setOpen(next) }} asSheet={false}>
        <DialogTrigger asChild><Button type="button" variant="outline" size="sm">Tools</Button></DialogTrigger>
        {open && <DialogContent className="sm:max-w-xl" showCloseButton={!saving}>
            <DialogHeader><DialogTitle>Tools</DialogTitle>
                <DialogDescription>Choose which capabilities {agent.name} can use.</DialogDescription>
            </DialogHeader>
            <WorkspaceTools key={agent.id} agent={agent} saving={saving} setSaving={setSaving} />
            <DialogFooter><DialogClose asChild><Button type="button" disabled={saving}>Done</Button></DialogClose></DialogFooter>
        </DialogContent>}
    </Dialog>
}

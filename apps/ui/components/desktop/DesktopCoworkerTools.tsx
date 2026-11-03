'use client'

import { useEffect, useId, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { Icon } from '@/components/ui/icon'
import { PanelGrid, PanelScroller, PanelSection } from '@/components/ui/panel-list'
import { PANEL_CARD } from '@/components/ui/panel-row'
import { Switch } from '@/components/ui/switch'
import type { CoworkerTools, CoworkerToolPatch, CoworkerToolRow, DesktopToolGroup } from '@/lib/desktop/coworker-tools'
import { getToolMeta } from '@/lib/tool-meta'
import { FolderIcon, PencilIcon, TerminalIcon, GlobeIcon, WrenchIcon } from '@/lib/icons'
import { cn } from '@/lib/utils'
import type { DesktopAgentView } from './DesktopApp'

async function requestTools(url: string, init: RequestInit): Promise<CoworkerTools> {
    const response = await fetch(url, init)
    if (!response.ok) {
        const error = await response.json().catch(() => ({}))
        throw new Error(typeof error.error === 'string' ? error.error : 'Could not reach this coworker’s tools.')
    }
    return response.json()
}

const nativeIcons = { workspaceRead: FolderIcon, workspaceWrite: PencilIcon, shell: TerminalIcon, webSearch: GlobeIcon, codeMode: TerminalIcon }

function CapabilityCard({ group, row, saving, toggle }: { group: DesktopToolGroup; row: CoworkerToolRow; saving: boolean; toggle: (patch: CoworkerToolPatch) => void }) {
    const id = useId()
    const icon = group === 'codex' ? nativeIcons[row.id as keyof typeof nativeIcons] ?? WrenchIcon : row.tools[0] ? getToolMeta(row.tools[0]).icon : WrenchIcon
    return <div className={cn('flex flex-col gap-2 p-3', PANEL_CARD)}>
        <div className="flex items-start justify-between gap-2">
            <Icon icon={icon} size="md" />
            <Switch id={id} checked={row.enabled} disabled={saving || (!row.available && !row.enabled)} aria-describedby={`${id}-info`}
                onCheckedChange={enabled => toggle({ group, id: row.id, enabled })} />
        </div>
        <div>
            <label htmlFor={id} className="text-sm font-medium">{row.label}</label>
            <div id={`${id}-info`} className="text-xs text-muted-foreground">
                <p>{row.description}</p>
                {row.unavailableReason && <p className="mt-1">{row.unavailableReason}</p>}
            </div>
        </div>
    </div>
}

function ToolsPanel({ agent, saving, setSaving }: { agent: DesktopAgentView; saving: boolean; setSaving: (value: boolean) => void }) {
    const url = `/api/desktop/agents/${encodeURIComponent(agent.id)}/tools`
    const [tools, setTools] = useState<CoworkerTools | null>(null)
    const [error, setError] = useState('')
    const [attempt, setAttempt] = useState(0)

    useEffect(() => {
        const controller = new AbortController()
        void requestTools(url, { cache: 'no-store', signal: controller.signal }).then(value => {
            if (!controller.signal.aborted) setTools(value)
        }).catch(cause => {
            if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : 'Could not load tools.')
        })
        return () => controller.abort()
    }, [url, attempt])

    async function toggle(patch: CoworkerToolPatch) {
        if (saving || !tools) return
        setSaving(true)
        setError('')
        try {
            setTools(await requestTools(url, {
                method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch),
            }))
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : 'Could not save this permission.')
        } finally { setSaving(false) }
    }

    return <PanelScroller className="space-y-4 px-1">
        {tools ? (['rerun', 'codex'] as const).map(group => <PanelSection key={group} label={group === 'rerun' ? 'Rerun tools' : 'Native Codex tools'}>
            {group === 'codex' && <p className="text-xs text-muted-foreground">These permissions apply when this coworker uses ChatGPT (Codex).</p>}
            <PanelGrid className="grid-cols-1 sm:grid-cols-2">
                {tools[group].map(row => <CapabilityCard key={row.id} group={group} row={row} saving={saving} toggle={toggle} />)}
            </PanelGrid>
        </PanelSection>) : !error && <p role="status" className="text-sm text-muted-foreground">Loading tools…</p>}
        {error && <div role="alert" className="space-y-2 text-sm text-destructive">{error}
            {!tools && <Button type="button" variant="outline" size="sm" onClick={() => { setError(''); setAttempt(n => n + 1) }}>Retry</Button>}
        </div>}
    </PanelScroller>
}

export function DesktopCoworkerTools({ agent }: { agent: DesktopAgentView }) {
    const [open, setOpen] = useState(false)
    const [saving, setSaving] = useState(false)
    return <Dialog open={open} onOpenChange={next => { if (!saving) setOpen(next) }} asSheet={false}>
        <DialogTrigger asChild><Button type="button" variant="outline" size="sm">Tools</Button></DialogTrigger>
        {open && <DialogContent className="flex max-h-[85dvh] flex-col sm:max-w-2xl" showCloseButton={!saving}>
            <DialogHeader><DialogTitle>Tools</DialogTitle>
                <DialogDescription>Choose what {agent.name} can do. Tool results, including file contents, may be sent to the selected model.</DialogDescription>
            </DialogHeader>
            <ToolsPanel key={agent.id} agent={agent} saving={saving} setSaving={setSaving} />
            <DialogFooter><DialogClose asChild><Button type="button" disabled={saving}>Done</Button></DialogClose></DialogFooter>
        </DialogContent>}
    </Dialog>
}

'use client'

import { useEffect, useId, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { Icon } from '@/components/ui/icon'
import { PanelGrid, PanelScroller, PanelSection } from '@/components/ui/panel-list'
import { PANEL_CARD } from '@/components/ui/panel-row'
import { Switch } from '@/components/ui/switch'
import type { CoworkerTools, CoworkerToolPatch, CoworkerToolRow, DesktopToolGroup } from '@/lib/desktop/coworker-tools'
import { DesktopCoworkerCallTargets } from './coworker-calls/DesktopCoworkerCallTargets'
import { FxToolsLoading } from './fx-repairs/PanelLoadingSkeletons'
import { getToolMeta } from '@/lib/tool-meta'
import { ChevronDownIcon, FolderIcon, PencilIcon, TerminalIcon, GlobeIcon, WandSparklesIcon, WrenchIcon } from '@/lib/icons'
import { cn } from '@/lib/utils'
import type { DesktopAgentView } from './DesktopApp'
import { useDesktopDialogControl, type DesktopDialogControl } from '@/lib/desktop/use-dialog-control'

async function requestTools(url: string, init: RequestInit): Promise<CoworkerTools> {
    const response = await fetch(url, init)
    if (!response.ok) {
        const error = await response.json().catch(() => ({}))
        throw new Error(typeof error.error === 'string' ? error.error : 'Could not reach this coworker’s tools.')
    }
    return response.json()
}

const nativeIcons = { workspaceRead: FolderIcon, workspaceWrite: PencilIcon, shell: TerminalIcon, webSearch: GlobeIcon, codeMode: TerminalIcon }

function CapabilityCard({ agentId, group, row, saving, toggle }: { agentId: string; group: DesktopToolGroup; row: CoworkerToolRow; saving: boolean; toggle: (patch: CoworkerToolPatch) => void }) {
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
        {group === 'rerun' && row.id === 'callAgent' && row.enabled && <DesktopCoworkerCallTargets key={agentId} agentId={agentId} />}
    </div>
}

function SelfImprovementCard({ row, nested, saving, toggle }: {
    row: CoworkerToolRow; nested: CoworkerToolRow[]; saving: boolean; toggle: (patch: CoworkerToolPatch) => void
}) {
    const id = useId()
    const masterId = `${id}-master`
    return <div className={cn('flex flex-col gap-2 p-3', PANEL_CARD)}>
        <div className="flex items-start justify-between gap-2">
            <Icon icon={WandSparklesIcon} size="md" />
            <Switch id={masterId} checked={row.enabled} disabled={saving || (!row.available && !row.enabled)} aria-describedby={`${masterId}-info`}
                onCheckedChange={enabled => toggle({ group: 'rerun', id: row.id, enabled })} />
        </div>
        <div>
            <label htmlFor={masterId} className="text-sm font-medium">{row.label}</label>
            <div id={`${masterId}-info`} className="text-xs text-muted-foreground">
                <p>{row.description}</p>
            </div>
        </div>
        {row.enabled && nested.length > 0 && <div className="mt-1 flex flex-col border-t border-border pt-1">
            {nested.map(child => <label key={child.id} className="flex items-center gap-2 py-1.5 px-1 rounded-md hover:bg-accent/40 transition-colors cursor-pointer">
                <span className="flex-1 min-w-0">
                    <span className="text-sm block truncate">{child.label}</span>
                    <span id={`${masterId}-${child.id}-info`} className="text-xs text-muted-foreground block">{child.description}</span>
                </span>
                <Switch id={`${masterId}-${child.id}`} checked={child.enabled} disabled={saving || !child.available} aria-describedby={`${masterId}-${child.id}-info`}
                    onCheckedChange={enabled => toggle({ group: 'rerun', id: child.id, enabled })} />
            </label>)}
        </div>}
    </div>
}

function ToolSections({ agentId, tools, unavailable = false, saving, toggle }: {
    agentId: string; tools: CoworkerTools; unavailable?: boolean; saving: boolean; toggle: (patch: CoworkerToolPatch) => void
}) {
    return (['rerun', 'codex'] as const).map(group => {
        // A previously granted tool whose prerequisite changed stays visible so it can be revoked.
        const rows = tools[group].filter(row => unavailable === (!row.available && !row.enabled))
        if (!rows.length) return null
        const selfRow = rows.find(row => row.id === 'self')
        const selfNested = rows.filter(row => row.parent === 'self')
        const grid = rows.filter(row => !row.parent && row.id !== 'self')
        return <PanelSection key={group} label={group === 'rerun' ? 'Rerun tools' : 'Native Codex tools'}>
            {group === 'codex' && !unavailable && <p className="text-xs text-muted-foreground">These permissions apply when this coworker uses ChatGPT (Codex).</p>}
            <PanelGrid className="grid-cols-1 sm:grid-cols-2">
                {grid.map(row => <CapabilityCard key={row.id} agentId={agentId} group={group} row={row} saving={saving} toggle={toggle} />)}
                {group === 'rerun' && !selfRow && selfNested.map(row => <CapabilityCard key={row.id} agentId={agentId} group={group} row={row} saving={saving} toggle={toggle} />)}
            </PanelGrid>
            {group === 'rerun' && selfRow && <div className="mt-3">
                <SelfImprovementCard row={selfRow} nested={selfNested} saving={saving} toggle={toggle} />
            </div>}
        </PanelSection>
    })
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

    const unavailableCount = tools ? [...tools.rerun, ...tools.codex].filter(row => !row.available && !row.enabled).length : 0
    return <PanelScroller className="space-y-4 px-1">
        {tools ? <>
            <ToolSections agentId={agent.id} tools={tools} saving={saving} toggle={toggle} />
            {unavailableCount > 0 && <Collapsible>
                <CollapsibleTrigger asChild>
                    <Button type="button" variant="ghost" className="group w-full justify-between">
                        Unavailable tools ({unavailableCount})
                        <ChevronDownIcon aria-hidden className="size-4 transition-transform group-data-[state=open]:rotate-180" />
                    </Button>
                </CollapsibleTrigger>
                <CollapsibleContent className="mt-2 space-y-4">
                    <ToolSections agentId={agent.id} tools={tools} unavailable saving={saving} toggle={toggle} />
                </CollapsibleContent>
            </Collapsible>}
        </> : !error && <FxToolsLoading />}
        {error && <div role="alert" className="space-y-2 text-sm text-destructive">{error}
            {!tools && <Button type="button" variant="outline" size="sm" onClick={() => { setError(''); setAttempt(n => n + 1) }}>Retry</Button>}
        </div>}
    </PanelScroller>
}

export function DesktopCoworkerTools({ agent, dialogControl }: { agent: DesktopAgentView; dialogControl?: DesktopDialogControl }) {
    const [open, setOpen] = useDesktopDialogControl(dialogControl)
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

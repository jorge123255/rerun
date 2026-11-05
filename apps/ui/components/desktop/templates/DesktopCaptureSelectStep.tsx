'use client'

import { useState } from 'react'
import { Checkbox } from '@/components/ui/checkbox'
import { EmptyState } from '@/components/ui/empty-state'
import { Field } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { SkeletonList } from '@/components/ui/skeleton'
import { BotIcon } from '@/lib/icons'
import { cn } from '@/lib/utils'
import type { DesktopCaptureSourceAgent, DesktopCaptureWorkspace } from './types'

export function DesktopCaptureSelectStep({ workspaces, workspaceId, loading, failed, selectedIds, onWorkspaceChange, onToggle, onSelectionChange }: {
    workspaces: DesktopCaptureWorkspace[]
    workspaceId: string
    loading: boolean
    failed: boolean
    selectedIds: string[]
    onWorkspaceChange: (workspaceId: string) => void
    onToggle: (agentId: string) => void
    onSelectionChange: (agentIds: string[]) => void
}) {
    const [query, setQuery] = useState('')
    if (loading) return <SkeletonList rows={4} />
    if (workspaces.length === 0) {
        if (failed) return null
        return <EmptyState icon={BotIcon} title="No coworker to capture" description="Create a coworker in this workspace first, then come back here." />
    }

    const workspace = workspaces.find(item => item.id === workspaceId)
    const agents = workspace?.agents ?? []
    const needle = query.trim().toLowerCase()
    const visible = needle ? agents.filter(agent => `${agent.name} ${agent.handle}`.toLowerCase().includes(needle)) : agents
    const allSelected = agents.length > 0 && agents.every(agent => selectedIds.includes(agent.id))

    return <div className="flex flex-col gap-4">
        {workspaces.length > 1 && <Field label="Workspace">
            <Select value={workspaceId} onValueChange={onWorkspaceChange}>
                <SelectTrigger className="w-full"><SelectValue placeholder="Pick a local workspace" /></SelectTrigger>
                <SelectContent>{workspaces.map(option => <SelectItem key={option.id} value={option.id}>{option.name ?? 'Workspace'} ({option.agents.length})</SelectItem>)}</SelectContent>
            </Select>
        </Field>}
        {workspace && <Field label={workspaces.length > 1 || !workspace.name ? 'Coworkers' : `Coworkers in ${workspace.name}`}>
            <div className="flex flex-col gap-2">
                {agents.length > 8 && <Input value={query} onChange={event => setQuery(event.target.value)} placeholder="Search by name or handle" className="h-9" />}
                {agents.length > 1 && <div className="flex items-center justify-between text-xs text-muted-foreground">
                    <span>{selectedIds.length} of {agents.length} selected</span>
                    <button type="button" className="text-foreground/70 hover:text-foreground" onClick={() => onSelectionChange(allSelected ? [] : agents.map(agent => agent.id))}>{allSelected ? 'Clear' : 'Select all'}</button>
                </div>}
                <div className="flex flex-col gap-1">
                    {visible.map(agent => <DesktopCaptureAgentRow key={agent.id} agent={agent} checked={selectedIds.includes(agent.id)} onToggle={() => onToggle(agent.id)} />)}
                    {visible.length === 0 && <p className="px-2 py-4 text-xs text-muted-foreground">No coworker matches this search.</p>}
                </div>
            </div>
        </Field>}
    </div>
}

function DesktopCaptureAgentRow({ agent, checked, onToggle }: { agent: DesktopCaptureSourceAgent; checked: boolean; onToggle: () => void }) {
    return <label className={cn('flex cursor-pointer items-center gap-3 rounded-md border border-transparent px-2 py-2 transition-colors hover:bg-foreground/5', checked && 'border-primary/40 bg-primary/5')}>
        <Checkbox size="sm" checked={checked} onCheckedChange={onToggle} />
        <span className="flex min-w-0 flex-1 flex-col">
            <span className="truncate text-sm font-medium">{agent.name}</span>
            <span className="flex min-w-0 items-baseline gap-1.5 text-xs text-muted-foreground">
                {agent.handle && <span className="shrink-0">@{agent.handle}</span>}
                {agent.description && <span className="truncate">{agent.description}</span>}
            </span>
        </span>
    </label>
}

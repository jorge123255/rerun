'use client'

import { WorkspacePill } from '@rerun/ui/chrome'
import { LayoutGrid, Settings } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import type { DesktopAgentView } from './DesktopApp'

export function DesktopWorkspaceMenu({ workspaceName, profileName, agents, selected, providerLabel, modelLabel, onBoard, onCoworker, onSettings }: {
    workspaceName: string
    profileName: string
    agents: DesktopAgentView[]
    selected: string | null
    providerLabel?: string
    modelLabel?: string
    onBoard: () => void
    onCoworker: (id: string) => void
    onSettings: () => void
}) {
    return <nav aria-label="Workspace" className="flex min-w-0 flex-wrap items-center gap-1.5">
        <DropdownMenu modal={false}>
            <DropdownMenuTrigger asChild>
                <WorkspacePill name={workspaceName} iconUrl="/pricing/solo.png" aria-label={`Workspace menu, ${workspaceName}`} />
            </DropdownMenuTrigger>
            <DropdownMenuContent className="w-64">
                <DropdownMenuLabel>{profileName} · Rerun Local</DropdownMenuLabel>
                <DropdownMenuItem onSelect={onBoard}><LayoutGrid /> Team board</DropdownMenuItem>
                <DropdownMenuItem onSelect={onSettings}><Settings /> Settings</DropdownMenuItem>
                {agents.length > 0 && <><DropdownMenuSeparator /><DropdownMenuLabel>Coworkers</DropdownMenuLabel></>}
                {agents.map(agent => <DropdownMenuItem key={agent.id} aria-current={selected === agent.id ? 'true' : undefined} onSelect={() => onCoworker(agent.id)}>
                    <span className="truncate">{agent.name}</span>
                </DropdownMenuItem>)}
            </DropdownMenuContent>
        </DropdownMenu>
        <Button type="button" variant="outline" size="sm" onClick={onSettings} aria-keyshortcuts="Meta+," title="Open model settings"
            className="h-8 rounded-full bg-background/90 px-2.5 text-xs backdrop-blur-xl">
            {providerLabel ? <span role="status" className="flex min-w-0 items-center gap-1.5">
                <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-emerald-500" />{providerLabel} is connected
                {modelLabel && <span className="max-w-36 truncate text-muted-foreground">{modelLabel}</span>}
            </span> : 'Set up provider'}
        </Button>
    </nav>
}

'use client'

import { WorkspacePill } from '@rerun/ui/chrome'
import { Brain, Database, Folder, Package, Keyboard, LayoutGrid, Search, Settings } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import type { DesktopAgentView } from './DesktopApp'
import { useRef } from 'react'
import { desktopWorkspaceIconSelectionUrl } from '@/lib/desktop/icon-catalog'

export function DesktopWorkspaceMenu({ workspaceName, iconCatalogId, iconUploadId, profileName, agents, selected, providerLabel, modelLabel, onBoard, onCoworker, onSettings, onWorkspaceSettings, onControlCenter, onShortcuts, onSharedData, onSharedFiles, onBrain, onTemplates, navigationDisabled = false, settingsDisabled = false }: {
    workspaceName: string
    iconCatalogId?: string | null
    iconUploadId?: string | null
    profileName: string
    agents: DesktopAgentView[]
    selected: string | null
    providerLabel?: string
    modelLabel?: string
    onBoard: () => void
    onCoworker: (id: string) => void
    onSettings: () => void
    onWorkspaceSettings?: () => void
    onControlCenter?: () => void
    onShortcuts?: () => void
    onSharedData?: () => void
    onSharedFiles?: () => void
    onBrain?: () => void
    onTemplates?: () => void
    navigationDisabled?: boolean
    settingsDisabled?: boolean
}) {
    const openingControlCenter = useRef(false)
    return <nav aria-label="Workspace" className="flex min-w-0 flex-wrap items-center gap-1.5">
        <DropdownMenu modal={false}>
            <DropdownMenuTrigger asChild>
                <WorkspacePill name={workspaceName} iconUrl={desktopWorkspaceIconSelectionUrl({ iconCatalogId: iconCatalogId ?? null, iconUploadId: iconUploadId ?? null }) ?? '/pricing/solo.png'} aria-label={`Workspace menu, ${workspaceName}`} />
            </DropdownMenuTrigger>
            <DropdownMenuContent className="w-64" onCloseAutoFocus={event => {
                if (openingControlCenter.current) event.preventDefault()
                openingControlCenter.current = false
            }}>
                <DropdownMenuLabel>{profileName} · Rerun Local</DropdownMenuLabel>
                <DropdownMenuItem onSelect={onBoard}><LayoutGrid /> Team board</DropdownMenuItem>
                {onSharedData && <DropdownMenuItem disabled={navigationDisabled} onSelect={() => { openingControlCenter.current = true; onSharedData() }}><Database /> Shared database</DropdownMenuItem>}
                {onSharedFiles && <DropdownMenuItem disabled={navigationDisabled} onSelect={() => { openingControlCenter.current = true; onSharedFiles() }}><Folder /> Shared files</DropdownMenuItem>}
                {onTemplates && <DropdownMenuItem disabled={navigationDisabled} onSelect={() => { openingControlCenter.current = true; onTemplates() }}><Package /> Templates</DropdownMenuItem>}
                {onBrain && <DropdownMenuItem disabled={navigationDisabled} onSelect={() => { openingControlCenter.current = true; onBrain() }}><Brain /> Company Brain</DropdownMenuItem>}
                {onControlCenter && <DropdownMenuItem disabled={navigationDisabled} onSelect={() => { openingControlCenter.current = true; onControlCenter() }}><Search /> Control center</DropdownMenuItem>}
                <DropdownMenuItem disabled={settingsDisabled} onSelect={onSettings}><Settings /> Settings</DropdownMenuItem>
                {onWorkspaceSettings && <DropdownMenuItem disabled={navigationDisabled} onSelect={() => { openingControlCenter.current = true; onWorkspaceSettings() }}><Settings /> Workspace settings</DropdownMenuItem>}
                {onShortcuts && <DropdownMenuItem disabled={navigationDisabled} onSelect={() => { openingControlCenter.current = true; onShortcuts() }}><Keyboard /> Keyboard shortcuts</DropdownMenuItem>}
                {agents.length > 0 && <><DropdownMenuSeparator /><DropdownMenuLabel>Coworkers</DropdownMenuLabel></>}
                {agents.map(agent => <DropdownMenuItem key={agent.id} disabled={navigationDisabled} aria-current={selected === agent.id ? 'true' : undefined} onSelect={() => onCoworker(agent.id)}>
                    <span className="truncate">{agent.name}</span>
                </DropdownMenuItem>)}
            </DropdownMenuContent>
        </DropdownMenu>
        <Button type="button" variant="outline" size="sm" disabled={settingsDisabled} onClick={onSettings} aria-keyshortcuts="Meta+," title="Open model settings"
            className="h-8 rounded-full bg-background/90 px-2.5 text-xs backdrop-blur-xl">
            {providerLabel ? <span role="status" className="flex min-w-0 items-center gap-1.5">
                <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-emerald-500" />{providerLabel} is connected
                {modelLabel && <span className="max-w-36 truncate text-muted-foreground">{modelLabel}</span>}
            </span> : 'Set up provider'}
        </Button>
    </nav>
}

'use client'

import { useDesktopLocale } from './DesktopLocale'
import { Brain, Cpu, Database, Folder, Import, KeyRound, Package, Keyboard, LayoutGrid, Search, Server, Settings, UserRound } from 'lucide-react'
import { ChromePill } from '@rerun/ui/chrome'
import { TooltipLabeled } from '@/components/ui/tooltip'
import { HelpCircleIcon } from '@/lib/icons'
import { Button } from '@/components/ui/button'
import { DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator } from '@/components/ui/dropdown-menu'
import type { DesktopAgentView } from './DesktopApp'
import { useEffect, useMemo, useRef } from 'react'
import { flushDesktopWorkspaceMetadata } from '@/lib/desktop/workspaces/metadata'
import { createDesktopWorkspaceClient } from '@/lib/desktop/workspaces'
import { DesktopWorkspaceSwitcher } from './workspaces/DesktopWorkspaceSwitcher'
import { DesktopWorkspaceSwitchLoader } from './workspaces/DesktopWorkspaceSwitchLoader'

export function DesktopWorkspaceMenu({ workspaceName, iconCatalogId, iconUploadId, profileName, profilePhoto, agents, selected, providerLabel, modelLabel, onBoard, onCoworker, onSettings, onProfile, onWorkspaceSettings, onControlCenter, onShortcuts, onHelp, onSharedData, onSharedFiles, onBrain, onTemplates, onVault, onExternalMcp, onServers, onImportCoworker, navigationDisabled = false, settingsDisabled = false }: {
    workspaceName: string
    iconCatalogId?: string | null
    iconUploadId?: string | null
    profileName: string
    profilePhoto?: string | null
    agents: DesktopAgentView[]
    selected: string | null
    providerLabel?: string
    modelLabel?: string
    onBoard: () => void
    onCoworker: (id: string) => void
    onSettings: () => void
    onProfile?: () => void
    onWorkspaceSettings?: () => void
    onControlCenter?: () => void
    onShortcuts?: () => void
    onHelp?: (trigger: HTMLButtonElement) => void
    onSharedData?: () => void
    onSharedFiles?: () => void
    onBrain?: () => void
    onTemplates?: () => void
    onVault?: () => void
    onExternalMcp?: () => void
    onServers?: () => void
    onImportCoworker?: () => void
    navigationDisabled?: boolean
    settingsDisabled?: boolean
}) {
    const { t } = useDesktopLocale()
    const openingControlCenter = useRef(false)
    const workspaceClient = useMemo(() => createDesktopWorkspaceClient(), [])
    useEffect(() => { void flushDesktopWorkspaceMetadata().catch(() => {}) }, [workspaceName, iconCatalogId, iconUploadId])
    const providerStatus = providerLabel ? t('boardUI.providerConnected', { provider: providerLabel }) : t('boardUI.providerSetup')
    const providerSummary = providerLabel && modelLabel ? `${providerStatus} · ${modelLabel}` : providerStatus
    return <nav aria-label={t('workspace')} className="flex min-w-0 items-center gap-1.5">
        <DesktopWorkspaceSwitcher className="pointer-events-auto" client={workspaceClient} profileLabel={`${profileName} · Rerun Local`} profilePhoto={profilePhoto} activeDisplay={{ name: workspaceName, iconCatalogId, iconUploadId }} disabled={navigationDisabled}
            workspaceSettingsInMenu
            onRenameActive={onWorkspaceSettings ? () => { openingControlCenter.current = true; onWorkspaceSettings() } : undefined}
            onCloseAutoFocus={event => {
                if (openingControlCenter.current) event.preventDefault()
                openingControlCenter.current = false
            }} menuItems={<>
                <DropdownMenuItem disabled={navigationDisabled} onSelect={onBoard}><LayoutGrid /> {t('board')}</DropdownMenuItem>
                {onSharedData && <DropdownMenuItem disabled={navigationDisabled} onSelect={() => { openingControlCenter.current = true; onSharedData() }}><Database /> Shared database</DropdownMenuItem>}
                {onSharedFiles && <DropdownMenuItem disabled={navigationDisabled} onSelect={() => { openingControlCenter.current = true; onSharedFiles() }}><Folder /> {t('sharedFiles.title')}</DropdownMenuItem>}
                {onTemplates && <DropdownMenuItem disabled={navigationDisabled} onSelect={() => { openingControlCenter.current = true; onTemplates() }}><Package /> {t('templates')}</DropdownMenuItem>}
                {onVault && <DropdownMenuItem disabled={navigationDisabled} onSelect={() => { openingControlCenter.current = true; onVault() }}><KeyRound /> Vault</DropdownMenuItem>}
                {onImportCoworker && <DropdownMenuItem disabled={navigationDisabled} onSelect={() => { openingControlCenter.current = true; onImportCoworker() }}><Import /> Import coworker</DropdownMenuItem>}
                {onBrain && <DropdownMenuItem disabled={navigationDisabled} onSelect={() => { openingControlCenter.current = true; onBrain() }}><Brain /> {t('brainDesktop.title')}</DropdownMenuItem>}
                {onControlCenter && <DropdownMenuItem disabled={navigationDisabled} onSelect={() => { openingControlCenter.current = true; onControlCenter() }}><Search /> {t('controlCenter.title')}</DropdownMenuItem>}
                <DropdownMenuItem disabled={settingsDisabled} onSelect={onSettings}><Settings /> {t('settings')}</DropdownMenuItem>
                {onExternalMcp && <DropdownMenuItem disabled={navigationDisabled} onSelect={() => { openingControlCenter.current = true; onExternalMcp() }}><KeyRound /> {t('controlCenter.commands.api_keys')}</DropdownMenuItem>}
                {onServers && <DropdownMenuItem disabled={navigationDisabled} onSelect={() => { openingControlCenter.current = true; onServers() }}><Server /> {t('controlCenter.localCommands.servers')}</DropdownMenuItem>}
                {onWorkspaceSettings && <DropdownMenuItem disabled={navigationDisabled} onSelect={() => { openingControlCenter.current = true; onWorkspaceSettings() }}><Settings /> {t('workspaceSettings')}</DropdownMenuItem>}
                {onProfile && <DropdownMenuItem disabled={navigationDisabled} onSelect={() => { openingControlCenter.current = true; onProfile() }}><UserRound /> {t('localProfile.title')}</DropdownMenuItem>}
                {onShortcuts && <DropdownMenuItem disabled={navigationDisabled} onSelect={() => { openingControlCenter.current = true; onShortcuts() }}><Keyboard /> {t('shortcutDialog.title')}</DropdownMenuItem>}
                {agents.length > 0 && <><DropdownMenuSeparator /><DropdownMenuLabel>Coworkers</DropdownMenuLabel></>}
                {agents.map(agent => <DropdownMenuItem key={agent.id} disabled={navigationDisabled} aria-current={selected === agent.id ? 'true' : undefined} onSelect={() => onCoworker(agent.id)}>
                    <span className="truncate">{agent.name}</span>
                </DropdownMenuItem>)}
            </>} />
        <DesktopWorkspaceSwitchLoader />
        {onHelp && <TooltipLabeled label={t('help')} side="bottom">
            <ChromePill type="button" start="icon" end="icon" disabled={navigationDisabled} aria-label={t('help')} className="pointer-events-auto"
                onClick={event => onHelp(event.currentTarget)}>
                <HelpCircleIcon className="size-4 text-muted-foreground" />
            </ChromePill>
        </TooltipLabeled>}
        <TooltipLabeled label={providerSummary} side="bottom">
            <Button type="button" variant="outline" size="sm" disabled={settingsDisabled} onClick={onSettings}
                aria-keyshortcuts="Meta+," title={t('boardUI.modelSettings')} aria-label={providerSummary}
                className="pointer-events-auto relative h-8 min-w-0 rounded-full bg-background/90 px-2.5 text-xs backdrop-blur-xl @max-md/board-header:size-8 @max-md/board-header:shrink-0 @max-md/board-header:p-0">
                <Cpu aria-hidden className="hidden @max-md/board-header:block" />
                <span role={providerLabel ? 'status' : undefined} className="flex min-w-0 items-center gap-1.5 @max-md/board-header:sr-only">
                    {providerLabel && <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-emerald-500" />}
                    <span className="truncate">{providerStatus}</span>
                    {providerLabel && modelLabel && <span className="max-w-36 truncate text-muted-foreground">{modelLabel}</span>}
                </span>
                {providerLabel && <span aria-hidden className="absolute top-1 right-1 hidden size-1.5 rounded-full bg-emerald-500 @max-md/board-header:block" />}
            </Button>
        </TooltipLabeled>
    </nav>
}

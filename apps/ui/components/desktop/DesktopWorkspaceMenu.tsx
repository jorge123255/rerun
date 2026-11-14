'use client'

import { useDesktopLocale } from './DesktopLocale'
import { Brain, Database, Folder, Import, KeyRound, Package, Keyboard, LayoutGrid, Search, Server, Settings, UserRound } from 'lucide-react'
import { ChromePill } from '@rerun/ui/chrome'
import { TooltipLabeled } from '@/components/ui/tooltip'
import { HelpCircleIcon } from '@/lib/icons'
import { DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator } from '@/components/ui/dropdown-menu'
import type { DesktopAgentView } from './DesktopApp'
import type { BoxDefaultModel, ConnectionSummary } from '@rerun/contracts'
import { DesktopProviderStatus } from './DesktopProviderStatus'
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { desktopVaultListing } from '@/lib/desktop/vault'
import { flushDesktopWorkspaceMetadata } from '@/lib/desktop/workspaces/metadata'
import { createDesktopWorkspaceClient } from '@/lib/desktop/workspaces'
import { DesktopWorkspaceSwitcher } from './workspaces/DesktopWorkspaceSwitcher'
import { DesktopWorkspaceSwitchLoader } from './workspaces/DesktopWorkspaceSwitchLoader'

export function DesktopWorkspaceMenu({ workspaceName, iconCatalogId, iconUploadId, profileName, profilePhoto, agents, selected, providerLabel, modelLabel, connections, workspaceDefault, onBoard, onCoworker, onSettings, onProfile, onWorkspaceSettings, onControlCenter, onShortcuts, onHelp, onSharedData, onSharedFiles, onBrain, onTemplates, onVault, onExternalMcp, onServers, onImportCoworker, viewRow, navigationDisabled = false, settingsDisabled = false }: {
    workspaceName: string
    iconCatalogId?: string | null
    iconUploadId?: string | null
    profileName: string
    profilePhoto?: string | null
    agents: DesktopAgentView[]
    selected: string | null
    providerLabel?: string
    modelLabel?: string
    /** Every provider connection, for the list the provider pill opens. */
    connections?: readonly ConnectionSummary[]
    workspaceDefault?: BoxDefaultModel | null
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
    viewRow?: ReactNode
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
    // Vault entries waiting on a sign-in: read each time the menu opens, which is when the row shows.
    const vaultEnabled = !!onVault
    const [vaultSignedOut, setVaultSignedOut] = useState(false)
    const refreshVaultSignedOut = useCallback(() => {
        if (!vaultEnabled) return
        void fetch('/api/desktop/vault', { cache: 'no-store' })
            .then(async response => response.ok ? desktopVaultListing.parse(await response.json()) : null)
            .then(listing => { if (listing) setVaultSignedOut(listing.entries.some(entry => 'kind' in entry && entry.kind === 'mcp' && entry.signedOut)) })
            .catch(() => {})
    }, [vaultEnabled])
    return <nav aria-label={t('workspace')} className="flex min-w-0 items-center gap-1.5">
        <DesktopWorkspaceSwitcher className="pointer-events-auto" client={workspaceClient} profileLabel={`${profileName} · Rerun Local`} profilePhoto={profilePhoto} activeDisplay={{ name: workspaceName, iconCatalogId, iconUploadId }} disabled={navigationDisabled}
            workspaceSettingsInMenu onMenuOpenChange={open => { if (open) refreshVaultSignedOut() }}
            onRenameActive={onWorkspaceSettings ? () => { openingControlCenter.current = true; onWorkspaceSettings() } : undefined}
            onCloseAutoFocus={event => {
                if (openingControlCenter.current) event.preventDefault()
                openingControlCenter.current = false
            }} menuItems={<>
                <DropdownMenuItem disabled={navigationDisabled} onSelect={onBoard}><LayoutGrid /> {t('board')}</DropdownMenuItem>
                {viewRow}
                {onSharedData && <DropdownMenuItem disabled={navigationDisabled} onSelect={() => { openingControlCenter.current = true; onSharedData() }}><Database /> Shared database</DropdownMenuItem>}
                {onSharedFiles && <DropdownMenuItem disabled={navigationDisabled} onSelect={() => { openingControlCenter.current = true; onSharedFiles() }}><Folder /> {t('sharedFiles.title')}</DropdownMenuItem>}
                {onTemplates && <DropdownMenuItem disabled={navigationDisabled} onSelect={() => { openingControlCenter.current = true; onTemplates() }}><Package /> {t('templates')}</DropdownMenuItem>}
                {onVault && <DropdownMenuItem disabled={navigationDisabled} onSelect={() => { openingControlCenter.current = true; onVault() }}><KeyRound /> Vault{vaultSignedOut && <span role="img" className="ml-auto size-2 rounded-full bg-orange-500" aria-label="An app of the Vault is signed out" />}</DropdownMenuItem>}
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
        <DesktopProviderStatus providerLabel={providerLabel} modelLabel={modelLabel} connections={connections} workspaceDefault={workspaceDefault} disabled={settingsDisabled} onSettings={onSettings} />
    </nav>
}

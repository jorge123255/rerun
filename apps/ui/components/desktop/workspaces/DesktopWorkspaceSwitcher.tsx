'use client'

import { CardAvatar } from '@rerun/ui/chat'
import { WorkspacePill } from '@rerun/ui/chrome'
import { CheckIcon, Loader2Icon, PlusIcon, SettingsIcon } from '@/lib/icons'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { CreateDesktopWorkspaceDialog } from './CreateDesktopWorkspaceDialog'
import { RenameDesktopWorkspaceDialog } from './RenameDesktopWorkspaceDialog'
import {
    abortDesktopWorkspaceSwitch,
    beginDesktopWorkspaceSwitch,
    DESKTOP_WORKSPACE_UI_COPY,
    enterDesktopActiveWorkspace,
    type DesktopWorkspaceClient,
} from '@/lib/desktop/workspaces'
import { desktopWorkspaceIconSelectionUrl } from '@/lib/desktop/icon-catalog'
import { cn } from '@/lib/utils'
import { useCallback, useEffect, useMemo, useState, type ReactNode, type ComponentProps } from 'react'
import type { DesktopWorkspaceListResult, DesktopWorkspaceRecord } from '@rerun/contracts'
import { toast } from 'sonner'
import { useDesktopLocale } from '../DesktopLocale'

/**
 * Local port of WorkspaceSwitcher workspace list + New workspace + rename entry.
 * Omits hosted billing, members, sandbox, expert, admin and cloud-only sections.
 * Mount beside or inside DesktopWorkspaceMenu once root wires the client.
 */
export function DesktopWorkspaceSwitcher({
    client,
    profileLabel = 'Rerun Local', profilePhoto,
    className, menuItems, activeDisplay, disabled = false, onCloseAutoFocus, onRenameActive, workspaceSettingsInMenu = false, onMenuOpenChange,
}: {
    client: DesktopWorkspaceClient
    profileLabel?: string
    profilePhoto?: string | null
    className?: string
    menuItems?: ReactNode
    onMenuOpenChange?: (open: boolean) => void
    activeDisplay?: { name: string; iconCatalogId?: string | null; iconUploadId?: string | null }
    disabled?: boolean
    onRenameActive?: () => void
    workspaceSettingsInMenu?: boolean
    onCloseAutoFocus?: ComponentProps<typeof DropdownMenuContent>['onCloseAutoFocus']
}) {
    const { t } = useDesktopLocale()
    const [snapshot, setSnapshot] = useState<DesktopWorkspaceListResult | null>(null)
    const [busy, setBusy] = useState(false)
    const [createOpen, setCreateOpen] = useState(false)
    const [renameOpen, setRenameOpen] = useState(false)
    const [loadError, setLoadError] = useState<string | null>(null)

    const refresh = useCallback(async () => {
        try {
            const next = await client.list()
            setSnapshot(next)
            setLoadError(null)
        } catch {
            setLoadError('Workspaces could not be loaded.')
        }
    }, [client])

    useEffect(() => { void refresh() }, [refresh])

    const sorted = useMemo(() => {
        const list = snapshot?.catalog.workspaces ?? []
        return [...list].sort((a, b) => a.workspaceId - b.workspaceId)
    }, [snapshot])

    const active = sorted.find(w => w.workspaceId === snapshot?.selection.workspaceId) ?? sorted[0] ?? null
    const openReceipt = snapshot?.openReceipt ?? null
    const switchBlocked = Boolean(openReceipt && openReceipt.phase !== 'published' && openReceipt.phase !== 'cancelled' && openReceipt.phase !== 'rolled_back' && openReceipt.phase !== 'failed_before_drain')

    const handleSwitch = async (workspace: DesktopWorkspaceRecord) => {
        if (busy || disabled || !active || workspace.workspaceId === active?.workspaceId) return
        if (switchBlocked) {
            toast.error(DESKTOP_WORKSPACE_UI_COPY.busySwitch)
            return
        }
        if (workspace.pathStatus === 'missing' || workspace.pathStatus === 'corrupt' || workspace.pathStatus === 'foreign') {
            toast.error(workspace.pathStatus === 'missing'
                ? 'This workspace folder is missing. Choose another workspace or recreate it.'
                : workspace.pathStatus === 'foreign'
                    ? 'This folder is not one of your workspaces.'
                    : 'This workspace folder cannot be opened. Choose another workspace.')
            return
        }
        setBusy(true)
        beginDesktopWorkspaceSwitch()
        try {
            const result = await client.switchTo({ requestId: crypto.randomUUID(), workspaceId: workspace.workspaceId })
            if (result.ok) {
                if (!client.native) enterDesktopActiveWorkspace()
                return
            }
            abortDesktopWorkspaceSwitch()
            toast.error(result.message)
            setBusy(false)
            await refresh()
        } catch {
            abortDesktopWorkspaceSwitch()
            toast.error('The workspace could not be switched.')
            setBusy(false)
        }
    }

    const handleCreated = (created: DesktopWorkspaceRecord) => {
        // Keep the confirmed workspace available if opening it fails and the catalog cannot refresh.
        setSnapshot(previous => previous && {
            ...previous,
            catalog: {
                ...previous.catalog,
                workspaces: [...previous.catalog.workspaces.filter(workspace => workspace.workspaceId !== created.workspaceId), created],
            },
        })
        void handleSwitch(created)
    }

    const iconUrl = desktopWorkspaceIconSelectionUrl({
        iconCatalogId: activeDisplay ? activeDisplay.iconCatalogId ?? null : active?.iconCatalogId ?? null,
        iconUploadId: activeDisplay?.iconUploadId ?? null,
    }) ?? '/pricing/solo.png'
    const name = activeDisplay?.name || active?.name || 'Workspace'
    return (
        <div className={cn('min-w-0', className)}>
            <DropdownMenu modal={false} onOpenChange={onMenuOpenChange}>
                <DropdownMenuTrigger asChild>
                    <WorkspacePill
                        name={name}
                        iconUrl={iconUrl}
                        className="max-w-full"
                        title={name}
                        aria-label={`Workspace menu, ${name}`}
                        aria-busy={busy || undefined}
                    />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" side="bottom" className="w-64 max-h-[calc(100dvh-5rem)] overflow-y-auto" onCloseAutoFocus={onCloseAutoFocus}>
                    <DropdownMenuLabel className="flex min-w-0 items-center gap-2 text-xs font-normal text-muted-foreground">
                        {profilePhoto && <CardAvatar src={profilePhoto} fileUrl={path => path === profilePhoto ? path : null} name={profileLabel} className="size-5" />}
                        <span className="truncate">{profileLabel}</span>
                    </DropdownMenuLabel>
                    {menuItems}
                    <DropdownMenuSeparator />
                    {sorted.map(workspace => {
                        const isActive = workspace.workspaceId === active?.workspaceId
                        return (
                            <DropdownMenuItem
                                key={workspace.workspaceId}
                                disabled={disabled || busy || switchBlocked || !snapshot}
                                onSelect={() => { void handleSwitch(workspace) }}
                                className={cn('gap-2', !isActive && 'text-muted-foreground')}
                            >
                                <img
                                    src={isActive && activeDisplay ? iconUrl : desktopWorkspaceIconSelectionUrl({ iconCatalogId: workspace.iconCatalogId, iconUploadId: null }) ?? '/pricing/solo.png'}
                                    alt=""
                                    className="size-5 shrink-0 rounded-full object-cover"
                                />
                                <span className="flex-1 truncate">{isActive ? name : workspace.name || 'Workspace'}</span>
                                {busy && isActive ? <Loader2Icon className="size-4 animate-spin" /> : isActive ? <CheckIcon className="size-4" /> : null}
                            </DropdownMenuItem>
                        )
                    })}
                    <DropdownMenuItem disabled={disabled || busy || switchBlocked || !snapshot} onSelect={() => setCreateOpen(true)} className="gap-2 text-muted-foreground">
                        <PlusIcon className="size-4" />
                        {t('newWorkspace.menu')}
                    </DropdownMenuItem>
                    {!workspaceSettingsInMenu && <><DropdownMenuSeparator />
                    <DropdownMenuItem disabled={disabled || busy || !active || switchBlocked} onSelect={() => onRenameActive ? onRenameActive() : setRenameOpen(true)} className="gap-2 text-muted-foreground">
                        <SettingsIcon className="size-4" />
                        {DESKTOP_WORKSPACE_UI_COPY.renameTitle}
                    </DropdownMenuItem></>}
                    {loadError && <p role="status" className="px-2 py-1.5 text-xs text-muted-foreground">{loadError}</p>}
                    {switchBlocked && (
                        <p className="px-2 py-1.5 text-xs text-muted-foreground">{DESKTOP_WORKSPACE_UI_COPY.busySwitch}</p>
                    )}
                    <p className="px-2 pb-1.5 text-xs text-muted-foreground">{DESKTOP_WORKSPACE_UI_COPY.draftsKept}</p>
                </DropdownMenuContent>
            </DropdownMenu>

            <CreateDesktopWorkspaceDialog
                open={createOpen}
                onOpenChange={setCreateOpen}
                client={client}
                onCreated={handleCreated}
            />
            <RenameDesktopWorkspaceDialog
                open={renameOpen}
                onOpenChange={setRenameOpen}
                workspace={active}
                client={client}
                onRenamed={() => { void refresh() }}
            />
        </div>
    )
}

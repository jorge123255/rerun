'use client'

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
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { DesktopWorkspaceListResult, DesktopWorkspaceRecord } from '@rerun/contracts'
import { toast } from 'sonner'

/**
 * Local port of WorkspaceSwitcher workspace list + New workspace + rename entry.
 * Omits hosted billing, members, sandbox, expert, admin and cloud-only sections.
 * Mount beside or inside DesktopWorkspaceMenu once root wires the client.
 */
export function DesktopWorkspaceSwitcher({
    client,
    profileLabel = 'Rerun Local',
    className,
}: {
    client: DesktopWorkspaceClient
    profileLabel?: string
    className?: string
}) {
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
        if (busy || !active || workspace.workspaceId === active.workspaceId) return
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
                enterDesktopActiveWorkspace()
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

    const handleCreated = async (workspaceId: number) => {
        await refresh()
        const created = (await client.list()).catalog.workspaces.find(w => w.workspaceId === workspaceId)
        if (created) await handleSwitch(created)
    }

    if (!active) {
        return (
            <div className={cn('min-w-0', className)}>
                <WorkspacePill name="Workspace" iconUrl="/pricing/solo.png" aria-label="Workspace menu" />
                {loadError && <p className="sr-only">{loadError}</p>}
            </div>
        )
    }

    const iconUrl = desktopWorkspaceIconSelectionUrl({
        iconCatalogId: active.iconCatalogId,
        iconUploadId: null,
    }) ?? '/pricing/solo.png'

    return (
        <div className={cn('min-w-0', className)}>
            <DropdownMenu modal={false}>
                <DropdownMenuTrigger asChild>
                    <WorkspacePill
                        name={active.name || 'Workspace'}
                        iconUrl={iconUrl}
                        aria-label={`Workspace menu, ${active.name || 'Workspace'}`}
                        aria-busy={busy || undefined}
                    />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" side="bottom" className="w-64 max-h-[calc(100dvh-5rem)] overflow-y-auto">
                    <DropdownMenuLabel className="truncate text-xs font-normal text-muted-foreground">{profileLabel}</DropdownMenuLabel>
                    {sorted.map(workspace => {
                        const isActive = workspace.workspaceId === active.workspaceId
                        return (
                            <DropdownMenuItem
                                key={workspace.workspaceId}
                                disabled={busy || switchBlocked}
                                onSelect={() => { void handleSwitch(workspace) }}
                                className={cn('gap-2', !isActive && 'text-muted-foreground')}
                            >
                                <img
                                    src={desktopWorkspaceIconSelectionUrl({ iconCatalogId: workspace.iconCatalogId, iconUploadId: null }) ?? '/pricing/solo.png'}
                                    alt=""
                                    className="size-5 shrink-0 rounded-full object-cover"
                                />
                                <span className="flex-1 truncate">{workspace.name || 'Workspace'}</span>
                                {busy && isActive ? <Loader2Icon className="size-4 animate-spin" /> : isActive ? <CheckIcon className="size-4" /> : null}
                            </DropdownMenuItem>
                        )
                    })}
                    <DropdownMenuItem disabled={busy || switchBlocked} onSelect={() => setCreateOpen(true)} className="gap-2 text-muted-foreground">
                        <PlusIcon className="size-4" />
                        {DESKTOP_WORKSPACE_UI_COPY.newWorkspace}
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem disabled={busy} onSelect={() => setRenameOpen(true)} className="gap-2 text-muted-foreground">
                        <SettingsIcon className="size-4" />
                        {DESKTOP_WORKSPACE_UI_COPY.renameTitle}
                    </DropdownMenuItem>
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

'use client'

import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuLabel, ContextMenuSeparator, ContextMenuSub, ContextMenuSubContent, ContextMenuSubTrigger, ContextMenuTrigger } from '@/components/ui/context-menu'
import { ShareAgentDialog } from '@/components/agent/share/ShareAgentDialog'
import { DeleteAgentDialog } from '@/components/dialogs/DeleteAgentDialog'
import { DeleteSpaceDialog } from '@/components/dialogs/DeleteSpaceDialog'
import { RenameAgentDialog } from '@/components/dialogs/RenameAgentDialog'
import { RenameBoxDialog } from '@/components/dialogs/RenameBoxDialog'
import { UNNAMED_BOX_LABEL } from '@/lib/board/types'
import { CopyPlusIcon, Link2, MessageCircle, PencilIcon, SettingsIcon, Trash2Icon } from '@/lib/icons'
import { useBoardStore } from '@/stores/board.store'
import { useState, type ReactNode } from 'react'

export type BoardContextTarget = { kind: 'agent'; id: string } | { kind: 'space'; id: string }

type BoardContextMenuProps = {
    children: ReactNode
    target: BoardContextTarget | null
    onTargetClear: () => void
}

export function BoardContextMenu({ children, target, onTargetClear }: BoardContextMenuProps) {
    const agents = useBoardStore(state => state.agents)
    const spaces = useBoardStore(state => state.spaces)
    const renameAgent = useBoardStore(state => state.renameAgent)
    const openAgentChat = useBoardStore(state => state.openAgentChat)
    const openAgentSettings = useBoardStore(state => state.openAgentSettings)
    const beginAgentDuplicatePlacement = useBoardStore(state => state.beginAgentDuplicatePlacement)
    const moveAgentToBox = useBoardStore(state => state.moveAgentToBox)
    const deleteSpace = useBoardStore(state => state.deleteSpace)
    const [deleteAgentId, setDeleteAgentId] = useState<string | null>(null)
    const [renameAgentId, setRenameAgentId] = useState<string | null>(null)
    const [shareAgentId, setShareAgentId] = useState<string | null>(null)
    const [deleteSpaceId, setDeleteSpaceId] = useState<string | null>(null)
    const [renameSpaceId, setRenameSpaceId] = useState<string | null>(null)

    const targetAgent = target?.kind === 'agent' ? agents.find(agent => agent.id === target.id) : undefined
    const targetSpace = target?.kind === 'space' ? spaces.find(space => space.id === target.id) : undefined
    const deleteAgent = deleteAgentId ? agents.find(agent => agent.id === deleteAgentId) : undefined
    const agentToRename = renameAgentId ? agents.find(agent => agent.id === renameAgentId) : undefined
    const shareAgent = shareAgentId ? agents.find(agent => agent.id === shareAgentId) : undefined
    const spaceToDelete = deleteSpaceId ? spaces.find(space => space.id === deleteSpaceId) : undefined
    const agentsInSpaceToDelete = deleteSpaceId ? agents.filter(agent => agent.spaceId === deleteSpaceId).length : 0
    const spaceToRename = renameSpaceId ? spaces.find(space => space.id === renameSpaceId) : undefined
    const otherBoxes = targetAgent ? spaces.filter(space => space.id !== targetAgent.spaceId) : []

    return (
        <>
            <ContextMenu
                onOpenChange={open => {
                    if (!open) onTargetClear()
                }}
            >
                <ContextMenuTrigger asChild>
                    <div className="absolute inset-0">{children}</div>
                </ContextMenuTrigger>
                {targetAgent && (
                    <ContextMenuContent>
                        <ContextMenuLabel className="max-w-56 truncate pl-7">{targetAgent.name}</ContextMenuLabel>
                        <ContextMenuSeparator />
                        <ContextMenuItem onSelect={() => openAgentChat(targetAgent.id)}>
                            <MessageCircle className="size-4" />
                            Open chat
                        </ContextMenuItem>
                        <ContextMenuItem onSelect={() => setRenameAgentId(targetAgent.id)}>
                            <PencilIcon className="size-4" />
                            Rename
                        </ContextMenuItem>
                        <ContextMenuItem onSelect={() => openAgentSettings(targetAgent.id)}>
                            <SettingsIcon className="size-4" />
                            Settings
                        </ContextMenuItem>
                        <ContextMenuItem onSelect={() => setShareAgentId(targetAgent.id)}>
                            <Link2 className="size-4" />
                            Share
                        </ContextMenuItem>
                        <ContextMenuItem onSelect={() => beginAgentDuplicatePlacement({ agentId: targetAgent.id, agentName: targetAgent.name })}>
                            <CopyPlusIcon className="size-4" />
                            Duplicate
                        </ContextMenuItem>
                        <ContextMenuSub>
                            <ContextMenuSubTrigger className="pl-7">Move to Box</ContextMenuSubTrigger>
                            <ContextMenuSubContent>
                                {otherBoxes.length === 0 ? (
                                    <ContextMenuItem disabled>No other Box yet</ContextMenuItem>
                                ) : (
                                    otherBoxes.map(space => (
                                        <ContextMenuItem key={space.id} className="max-w-56 truncate" onSelect={() => moveAgentToBox(targetAgent.id, space.id)}>
                                            {space.name || UNNAMED_BOX_LABEL}
                                        </ContextMenuItem>
                                    ))
                                )}
                            </ContextMenuSubContent>
                        </ContextMenuSub>
                        <ContextMenuSeparator />
                        <ContextMenuItem variant="destructive" onSelect={() => setDeleteAgentId(targetAgent.id)}>
                            <Trash2Icon className="size-4" />
                            Delete
                        </ContextMenuItem>
                    </ContextMenuContent>
                )}
                {targetSpace && (
                    <ContextMenuContent>
                        <ContextMenuLabel className="max-w-56 truncate pl-7">{targetSpace.name || UNNAMED_BOX_LABEL}</ContextMenuLabel>
                        <ContextMenuSeparator />
                        <ContextMenuItem onSelect={() => setRenameSpaceId(targetSpace.id)}>
                            <PencilIcon className="size-4" />
                            Rename
                        </ContextMenuItem>
                        <ContextMenuSeparator />
                        <ContextMenuItem variant="destructive" onSelect={() => setDeleteSpaceId(targetSpace.id)}>
                            <Trash2Icon className="size-4" />
                            Delete
                        </ContextMenuItem>
                    </ContextMenuContent>
                )}
            </ContextMenu>

            {shareAgentId && (
                <ShareAgentDialog
                    agentId={shareAgentId}
                    agentName={shareAgent?.name ?? 'this coworker'}
                    open
                    onOpenChange={open => {
                        if (!open) setShareAgentId(null)
                    }}
                />
            )}

            {deleteAgentId && (
                <DeleteAgentDialog
                    agentId={deleteAgentId}
                    agentName={deleteAgent?.name}
                    open
                    onOpenChange={open => {
                        if (!open) setDeleteAgentId(null)
                    }}
                />
            )}

            <RenameAgentDialog
                agent={agentToRename}
                onRename={renameAgent}
                open={!!renameAgentId}
                onOpenChange={open => {
                    if (!open) setRenameAgentId(null)
                }}
            />

            <RenameBoxDialog
                space={spaceToRename}
                open={!!renameSpaceId}
                onOpenChange={open => {
                    if (!open) setRenameSpaceId(null)
                }}
            />

            <DeleteSpaceDialog
                open={!!deleteSpaceId}
                spaceName={spaceToDelete?.name ?? undefined}
                agentCount={agentsInSpaceToDelete}
                onOpenChange={open => {
                    if (!open) setDeleteSpaceId(null)
                }}
                onConfirm={() => {
                    if (deleteSpaceId) deleteSpace(deleteSpaceId)
                    setDeleteSpaceId(null)
                }}
            />
        </>
    )
}

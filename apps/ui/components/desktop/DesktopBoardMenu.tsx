import { useRef, useState, type ReactNode } from 'react'
import { CopyPlusIcon, MessageCircle, PencilIcon, PowerIcon, PowerOffIcon, Trash2Icon } from 'lucide-react'
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuLabel, ContextMenuSeparator, ContextMenuTrigger } from '@/components/ui/context-menu'
import { RenameAgentDialog } from '@/components/dialogs/RenameAgentDialog'
import { DeleteCoworkerConfirmation } from '@/components/dialogs/DeleteCoworkerConfirmation'
import { Button } from '@/components/ui/button'
import type { DesktopAgentView } from './DesktopApp'

export function DesktopBoardMenu({ agents, onOpen, onRename, onDuplicate, onSetEnabled, onDelete, disabled, children }: {
    agents: DesktopAgentView[]
    onOpen: (id: string) => void
    onRename?: (id: string, name: string) => Promise<void>
    onDuplicate?: (agent: DesktopAgentView) => void
    onSetEnabled?: (id: string, enabled: boolean) => Promise<void>
    onDelete?: (id: string, confirmationName: string) => Promise<void>
    disabled?: boolean
    children: (onTileContextMenu: (id: string) => void) => ReactNode
}) {
    const [targetId, setTargetId] = useState<string | null>(null)
    const [renaming, setRenaming] = useState<DesktopAgentView>()
    const [deleting, setDeleting] = useState<DesktopAgentView>()
    const board = useRef<HTMLDivElement>(null)
    const startingPlacement = useRef(false)
    const saving = useRef(false)
    const [activation, setActivation] = useState<{ id: string; name: string; enabled: boolean; error?: string } | null>(null)
    const target = agents.find(agent => agent.id === targetId)
    function focusTile(id: string) {
        const tiles = Array.from(board.current?.querySelectorAll<HTMLElement>('[data-tile-id]') ?? [])
        ;(tiles.find(tile => tile.dataset.tileId === id) ?? tiles[0])?.focus({ preventScroll: true })
    }
    async function setEnabled(agent: { id: string; name: string }, enabled: boolean) {
        if (!onSetEnabled || saving.current) return
        saving.current = true
        setActivation({ id: agent.id, name: agent.name, enabled })
        try {
            await onSetEnabled(agent.id, enabled)
            setActivation(null)
        } catch (error) {
            setActivation({ id: agent.id, name: agent.name, enabled,
                error: error instanceof Error ? error.message : `Could not ${enabled ? 'enable' : 'disable'} this coworker. Try again.` })
        } finally {
            saving.current = false
        }
    }
    return <>
        <ContextMenu onOpenChange={open => { if (!open) setTargetId(null) }}>
            <ContextMenuTrigger asChild disabled={disabled}>
                <div ref={board} className="absolute inset-0" onKeyDown={event => {
                    if (disabled) return
                    if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return
                    const tile = (event.target as HTMLElement).closest<HTMLElement>('[data-tile-id]')
                    if (!tile?.dataset.tileId) return
                    event.preventDefault()
                    const { left, bottom } = tile.getBoundingClientRect()
                    setTargetId(tile.dataset.tileId)
                    event.currentTarget.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: left, clientY: bottom }))
                }}>
                    {children(setTargetId)}
                </div>
            </ContextMenuTrigger>
            {target && <ContextMenuContent onCloseAutoFocus={event => {
                if (startingPlacement.current) { event.preventDefault(); startingPlacement.current = false }
            }}>
                <ContextMenuLabel className="max-w-56 truncate pl-7">{target.name}</ContextMenuLabel>
                <ContextMenuSeparator />
                <ContextMenuItem onSelect={() => onOpen(target.id)}><MessageCircle className="size-4" />Open chat</ContextMenuItem>
                {onDuplicate && <ContextMenuItem onSelect={() => { startingPlacement.current = true; onDuplicate(target) }}>
                    <CopyPlusIcon className="size-4" />Duplicate
                </ContextMenuItem>}
                {onRename && <ContextMenuItem onSelect={() => setRenaming(target)}><PencilIcon className="size-4" />Rename</ContextMenuItem>}
                {onSetEnabled && <>
                    <ContextMenuSeparator />
                    <ContextMenuItem disabled={!!activation && !activation.error} onSelect={() => void setEnabled(target, target.enabled === false)}>
                        {target.enabled === false ? <PowerIcon className="size-4" /> : <PowerOffIcon className="size-4" />}
                        {target.enabled === false ? 'Enable' : 'Disable'}
                    </ContextMenuItem>
                </>}
                {onDelete && <>
                    <ContextMenuSeparator />
                    <ContextMenuItem variant="destructive" onSelect={() => setDeleting(target)}><Trash2Icon className="size-4" />Delete</ContextMenuItem>
                </>}
            </ContextMenuContent>}
        </ContextMenu>
        {activation && agents.some(agent => agent.id === activation.id) && <div role={activation.error ? 'alert' : 'status'} className="absolute bottom-20 left-4 z-40 flex max-w-[calc(100%-2rem)] items-center gap-2 rounded-xl border bg-background px-3 py-2 text-sm shadow-sm">
            <p>{activation.error || `${activation.enabled ? 'Enabling' : 'Disabling'} ${activation.name}…`}</p>
            {activation.error && <>
                <Button type="button" variant="outline" size="sm" onClick={() => void setEnabled(activation, activation.enabled)}>Retry</Button>
                <Button type="button" variant="ghost" size="sm" onClick={() => setActivation(null)}>Dismiss</Button>
            </>}
        </div>}
        {onRename && renaming && <RenameAgentDialog agent={renaming} open onRename={onRename}
            onOpenChange={open => { if (!open) setRenaming(undefined) }} onRestoreFocus={() => focusTile(renaming.id)} />}
        {onDelete && deleting && <DeleteCoworkerConfirmation key={deleting.id} agentName={deleting.name} open
            description="This will permanently delete the coworker and its chats, files and memories from this Mac. This action cannot be undone."
            onDelete={confirmationName => onDelete(deleting.id, confirmationName)}
            onOpenChange={open => { if (!open) setDeleting(undefined) }} onRestoreFocus={() => focusTile(deleting.id)} />}
    </>
}

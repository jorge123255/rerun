import { useRef, useState, type ReactNode } from 'react'
import { CopyPlusIcon, MessageCircle, PencilIcon } from 'lucide-react'
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuLabel, ContextMenuSeparator, ContextMenuTrigger } from '@/components/ui/context-menu'
import { RenameAgentDialog } from '@/components/dialogs/RenameAgentDialog'
import type { DesktopAgentView } from './DesktopApp'

export function DesktopBoardMenu({ agents, onOpen, onRename, onDuplicate, disabled, children }: {
    agents: DesktopAgentView[]
    onOpen: (id: string) => void
    onRename?: (id: string, name: string) => Promise<void>
    onDuplicate?: (agent: DesktopAgentView) => void
    disabled?: boolean
    children: (onTileContextMenu: (id: string) => void) => ReactNode
}) {
    const [targetId, setTargetId] = useState<string | null>(null)
    const [renaming, setRenaming] = useState<DesktopAgentView>()
    const board = useRef<HTMLDivElement>(null)
    const startingPlacement = useRef(false)
    const target = agents.find(agent => agent.id === targetId)
    function focusTile(id: string) {
        Array.from(board.current?.querySelectorAll<HTMLElement>('[data-tile-id]') ?? [])
            .find(tile => tile.dataset.tileId === id)?.focus({ preventScroll: true })
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
            </ContextMenuContent>}
        </ContextMenu>
        {onRename && renaming && <RenameAgentDialog agent={renaming} open onRename={onRename}
            onOpenChange={open => { if (!open) setRenaming(undefined) }} onRestoreFocus={() => focusTile(renaming.id)} />}
    </>
}

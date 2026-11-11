import { useDesktopLocale } from './DesktopLocale'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { CopyPlusIcon, Link2, MessageCircle, PencilIcon, PowerIcon, PowerOffIcon, Trash2Icon } from 'lucide-react'
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuLabel, ContextMenuSeparator, ContextMenuSub, ContextMenuSubContent, ContextMenuSubTrigger, ContextMenuTrigger } from '@/components/ui/context-menu'
import { RenameAgentDialog } from '@/components/dialogs/RenameAgentDialog'
import { DeleteCoworkerConfirmation } from '@/components/dialogs/DeleteCoworkerConfirmation'
import { Button } from '@/components/ui/button'
import type { DesktopAgentView } from './DesktopApp'
import type { DesktopBoardState } from '@/lib/desktop/spaces'
import { isDesktopQuitting } from '@/lib/desktop/draft-writes'
import { desktopSpaceLabel, firstDesktopSpacePosition } from './desktop-space-layout'

export function DesktopBoardMenu({ agents, onOpen, onRename, onShare, onDuplicate, onSetEnabled, onDelete, disabled, children, spaces, onRenameSpace, onDeleteSpace, onMoveAgent, onInteractionChange }: {
    agents: DesktopAgentView[]
    onOpen: (id: string) => void
    onRename?: (id: string, name: string) => Promise<void>
    onShare?: (agent: DesktopAgentView) => void
    onDuplicate?: (agent: DesktopAgentView) => void
    onSetEnabled?: (id: string, enabled: boolean) => Promise<void>
    onDelete?: (id: string, confirmationName: string) => Promise<void>
    disabled?: boolean
    spaces?: DesktopBoardState
    onRenameSpace?: (id: string) => void
    onDeleteSpace?: (id: string) => void
    onMoveAgent?: (agentId: string, spaceId: string) => Promise<void>
    onInteractionChange?: (active: boolean) => void
    children: (onTileContextMenu: (id: string) => void, onContainerContextMenu: (id: string) => void) => ReactNode
}) {
    const { t } = useDesktopLocale()
    const [targetId, setTargetId] = useState<string | null>(null)
    const [spaceId, setSpaceId] = useState<string | null>(null)
    const [menuOpen, setMenuOpen] = useState(false)
    const [renaming, setRenaming] = useState<DesktopAgentView>()
    const [deleting, setDeleting] = useState<DesktopAgentView>()
    const board = useRef<HTMLDivElement>(null)
    const startingPlacement = useRef(false)
    const saving = useRef(false)
    const [activation, setActivation] = useState<{ id: string; name: string; enabled: boolean; error?: string } | null>(null)
    const target = agents.find(agent => agent.id === targetId)
    const targetSpace = spaces?.spaces.find(space => space.id === spaceId)
    const sourceSpaceId = spaces?.placements.find(placed => placed.agentId === targetId)?.spaceId
    const otherBoxes = spaces?.spaces.filter(space => space.id !== sourceSpaceId) ?? []
    const menuScope = JSON.stringify([menuOpen, targetId, spaceId, spaces?.revision])
    const menuIdentity = useRef({ scope: menuScope, generation: 0 })
    if (menuIdentity.current.scope !== menuScope) menuIdentity.current = { scope: menuScope, generation: menuIdentity.current.generation + 1 }
    const menuGeneration = menuIdentity.current.generation
    const latest = useRef({ agents, disabled, spaces, onMoveAgent, onRenameSpace, onDeleteSpace })
    latest.current = { agents, disabled, spaces, onMoveAgent, onRenameSpace, onDeleteSpace }
    const interactionCallback = useRef(onInteractionChange)
    interactionCallback.current = onInteractionChange
    const interacting = menuOpen || !!renaming || !!deleting || (!!activation && !activation.error)
    useEffect(() => { interactionCallback.current?.(interacting) }, [interacting])
    useEffect(() => () => { interactionCallback.current?.(false) }, [])
    const available = () => !latest.current.disabled && !isDesktopQuitting()
    const currentMenu = () => available() && menuOpen && menuIdentity.current.generation === menuGeneration
    function targetAgent(id: string) { if (available()) { setSpaceId(null); setTargetId(id) } }
    function targetBox(id: string) { if (available()) { setTargetId(null); setSpaceId(id) } }
    function boxAction(id: string, action: 'rename' | 'delete') {
        if (!currentMenu() || !latest.current.spaces?.spaces.some(space => space.id === id)) return
        if (action === 'rename') latest.current.onRenameSpace?.(id)
        else latest.current.onDeleteSpace?.(id)
    }
    function focusTile(id: string) {
        const tiles = Array.from(board.current?.querySelectorAll<HTMLElement>('[data-tile-id]') ?? [])
        ;(tiles.find(tile => tile.dataset.tileId === id) ?? tiles[0])?.focus({ preventScroll: true })
    }
    async function setEnabled(agent: { id: string; name: string }, enabled: boolean) {
        if (!onSetEnabled || saving.current || !available() || !latest.current.agents.some(live => live.id === agent.id)) return
        saving.current = true
        setActivation({ id: agent.id, name: agent.name, enabled })
        try {
            await onSetEnabled(agent.id, enabled)
            setActivation(null)
        } catch (error) {
            setActivation({ id: agent.id, name: agent.name, enabled,
                error: error instanceof Error ? error.message : t(enabled ? 'coworker.enableFailed' : 'coworker.disableFailed') })
        } finally {
            saving.current = false
        }
    }
    return <>
        <ContextMenu onOpenChange={open => { setMenuOpen(open); if (!open) { setTargetId(null); setSpaceId(null) } }}>
            <ContextMenuTrigger asChild disabled={disabled}>
                <div ref={board} className="absolute inset-0" onKeyDown={event => {
                    if (!available()) return
                    if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return
                    const tile = (event.target as HTMLElement).closest<HTMLElement>('[data-tile-id]')
                    const element = (event.target as HTMLElement).closest<HTMLElement>('[aria-label]')
                    const box = spaces?.spaces.find((space, index) => element?.getAttribute('aria-label') === desktopSpaceLabel(space, index, spaces.spaces.length))
                    if (!tile?.dataset.tileId && !box) return
                    event.preventDefault()
                    const { left, bottom } = (tile ?? element!).getBoundingClientRect()
                    if (tile?.dataset.tileId) targetAgent(tile.dataset.tileId)
                    else if (box) targetBox(box.id)
                    event.currentTarget.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: left, clientY: bottom }))
                }}>
                    {children(targetAgent, targetBox)}
                </div>
            </ContextMenuTrigger>
            {target && <ContextMenuContent onCloseAutoFocus={event => {
                if (startingPlacement.current) { event.preventDefault(); startingPlacement.current = false }
            }}>
                <ContextMenuLabel className="max-w-56 truncate pl-7">{target.name}</ContextMenuLabel>
                <ContextMenuSeparator />
                <ContextMenuItem onSelect={() => onOpen(target.id)}><MessageCircle className="size-4" />{t('coworker.open')}</ContextMenuItem>
                {onRename && <ContextMenuItem onSelect={() => setRenaming(target)}><PencilIcon className="size-4" />{t('coworker.rename')}</ContextMenuItem>}
                {onShare && <ContextMenuItem onSelect={() => {
                    if (!currentMenu() || !latest.current.agents.some(agent => agent.id === target.id)) return
                    startingPlacement.current = true
                    onShare(target)
                }}><Link2 className="size-4" />{t('coworker.share')}</ContextMenuItem>}
                {onDuplicate && <ContextMenuItem onSelect={() => { startingPlacement.current = true; onDuplicate(target) }}>
                    <CopyPlusIcon className="size-4" />{t('coworker.duplicate')}
                </ContextMenuItem>}
                {spaces && onMoveAgent && <ContextMenuSub>
                    <ContextMenuSubTrigger className="pl-7">{t('coworker.moveBox')}</ContextMenuSubTrigger>
                    <ContextMenuSubContent>{otherBoxes.length === 0 ? <ContextMenuItem disabled>{t('coworker.noOtherBox')}</ContextMenuItem> : otherBoxes.map(space =>
                        <ContextMenuItem key={space.id} className="max-w-56 truncate" disabled={!firstDesktopSpacePosition(spaces, space.id, target.id)} onSelect={() => {
                            const live = latest.current
                            if (!currentMenu() || !live.agents.some(agent => agent.id === target.id) || !live.spaces || !firstDesktopSpacePosition(live.spaces, space.id, target.id)) return
                            void live.onMoveAgent?.(target.id, space.id).catch(() => {})
                        }}>{space.name}</ContextMenuItem>)}</ContextMenuSubContent>
                </ContextMenuSub>}
                {onSetEnabled && <>
                    <ContextMenuSeparator />
                    <ContextMenuItem disabled={!!activation && !activation.error} onSelect={() => void setEnabled(target, target.enabled === false)}>
                        {target.enabled === false ? <PowerIcon className="size-4" /> : <PowerOffIcon className="size-4" />}
                        {t(target.enabled === false ? 'coworker.enable' : 'coworker.disable')}
                    </ContextMenuItem>
                </>}
                {onDelete && <>
                    <ContextMenuSeparator />
                    <ContextMenuItem variant="destructive" onSelect={() => setDeleting(target)}><Trash2Icon className="size-4" />{t('coworker.delete')}</ContextMenuItem>
                </>}
            </ContextMenuContent>}
            {targetSpace && <ContextMenuContent>
                <ContextMenuLabel className="max-w-56 truncate pl-7">{targetSpace.name}</ContextMenuLabel><ContextMenuSeparator />
                {onRenameSpace && <ContextMenuItem onSelect={() => boxAction(targetSpace.id, 'rename')}><PencilIcon className="size-4" />{t('coworker.rename')}</ContextMenuItem>}
                {onDeleteSpace && <><ContextMenuSeparator /><ContextMenuItem variant="destructive" onSelect={() => boxAction(targetSpace.id, 'delete')}><Trash2Icon className="size-4" />{t('coworker.delete')}</ContextMenuItem></>}
            </ContextMenuContent>}
        </ContextMenu>
        {activation && agents.some(agent => agent.id === activation.id) && <div role={activation.error ? 'alert' : 'status'} className="absolute bottom-20 left-4 z-40 flex max-w-[calc(100%-2rem)] items-center gap-2 rounded-xl border bg-background px-3 py-2 text-sm shadow-sm">
            <p>{activation.error || t(activation.enabled ? 'coworker.enabling' : 'coworker.disabling', { name: activation.name })}</p>
            {activation.error && <>
                <Button type="button" variant="outline" size="sm" onClick={() => void setEnabled(activation, activation.enabled)}>{t('coworker.retry')}</Button>
                <Button type="button" variant="ghost" size="sm" onClick={() => setActivation(null)}>{t('coworker.dismiss')}</Button>
            </>}
        </div>}
        {onRename && renaming && <RenameAgentDialog agent={renaming} open labels={{
            title: t('coworker.renameTitle'), description: t('coworker.renameDescription'), name: t('coworker.name'),
            required: t('coworker.nameRequired'), tooLong: t('coworker.nameTooLong', { max: 60 }),
            failed: t('coworker.renameFailed'), cancel: t('cancel'), submit: t('coworker.rename'),
        }} onRename={onRename}
            onOpenChange={open => { if (!open) setRenaming(undefined) }} onRestoreFocus={() => focusTile(renaming.id)} />}
        {onDelete && deleting && <DeleteCoworkerConfirmation key={deleting.id} agentName={deleting.name} open
            description={t('coworker.deleteDescription')} labels={{
                title: t('coworker.deleteTitle'), input: t('coworker.deleteInput'),
                confirm: name => <>{t.rich('coworker.deleteConfirm', { name, b: chunks => <span className="font-medium text-foreground">{chunks}</span> })}</>,
                failed: t('coworker.deleteFailed'), cancel: t('cancel'), deleting: t('coworker.deleting'), submit: t('coworker.delete'),
            }}
            onDelete={confirmationName => onDelete(deleting.id, confirmationName)}
            onOpenChange={open => { if (!open) setDeleting(undefined) }} onRestoreFocus={() => focusTile(deleting.id)} />}
    </>
}

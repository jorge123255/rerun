'use client'

import { ChevronDown, Ellipsis, Pencil, Trash2 } from 'lucide-react'
import type { CSSProperties, HTMLAttributes, ReactNode, Ref } from 'react'
import { Button } from '@/components/ui/button'
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from '@/components/ui/context-menu'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'
import { useDesktopLocale } from '../DesktopLocale'

export type DesktopBoxDialogKind = 'rename' | 'delete'

/**
 * One Box in the Simple view's list: its name, folded or not, then its coworkers (upstream #279).
 * Its menu renames or deletes it with the board's own dialogs. Upstream's "who can access it" is
 * left out: a workspace on this Mac has one person.
 */
export function DesktopSidebarBoxSection<A extends { id: string }>({ box, members, collapsed, waiting, disabled = false, onToggle, onDialog, renderTile, drag }: {
    box: { id: string; name: string | null }
    members: readonly A[]
    collapsed: boolean
    // One of its coworkers waits for the person: said by a dot while the Box is folded.
    waiting: boolean
    disabled?: boolean
    onToggle: () => void
    // Left out where the board cannot change its Boxes: the Box then has no menu.
    onDialog?: (kind: DesktopBoxDialogKind) => void
    renderTile: (agent: A) => ReactNode
    // Dragging the list: the section moves by its header, and lights up while a coworker hovers it.
    drag?: { ref: Ref<HTMLElement>; style: CSSProperties; handle: HTMLAttributes<HTMLDivElement>; dragging: boolean; target: boolean }
}) {
    const { t } = useDesktopLocale()
    const label = box.name?.trim() || 'Box'
    const header = <div {...drag?.handle} className="group relative flex h-8 items-center rounded-md transition-colors outline-none hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring/50">
        <button type="button" disabled={disabled} aria-expanded={!collapsed} data-simple-box-toggle={box.id} onClick={onToggle} className="flex h-full min-w-0 flex-1 items-center gap-1.5 pr-8 pl-2 text-left text-xs font-medium text-muted-foreground">
            <ChevronDown className={cn('size-3 shrink-0 transition-transform', collapsed && '-rotate-90')} />
            <span className="truncate">{label}</span>
            <span data-simple-box-count className="shrink-0 text-muted-foreground/60 tabular-nums">{members.length}</span>
            {collapsed && waiting && <span data-simple-box-waiting className="size-1.5 shrink-0 rounded-full bg-orange-400" />}
        </button>
        {onDialog && <DropdownMenu>
            <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon-sm" disabled={disabled} aria-label={t('workspaceView.list.boxMore', { name: label })}
                    className="absolute top-1 right-1 size-6 opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 data-[state=open]:opacity-100">
                    <Ellipsis className="size-3.5" />
                </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" side="right" className="w-auto">
                <DropdownMenuItem onSelect={() => onDialog('rename')} className="w-full gap-2 whitespace-nowrap"><Pencil className="size-4" />{t('coworker.rename')}</DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem variant="destructive" onSelect={() => onDialog('delete')} className="w-full gap-2 whitespace-nowrap"><Trash2 className="size-4" />{t('coworker.delete')}</DropdownMenuItem>
            </DropdownMenuContent>
        </DropdownMenu>}
    </div>
    return <section ref={drag?.ref} style={drag?.style} aria-label={label} data-simple-box-id={box.id}
        className={cn('rounded-lg transition-colors', drag?.dragging && 'opacity-40', drag?.target && 'bg-accent/40 ring-1 ring-border')}>
        {onDialog && !disabled ? <ContextMenu>
            <ContextMenuTrigger asChild>{header}</ContextMenuTrigger>
            <ContextMenuContent>
                <ContextMenuItem onSelect={() => onDialog('rename')} className="w-full gap-2 whitespace-nowrap"><Pencil className="size-4" />{t('coworker.rename')}</ContextMenuItem>
                <ContextMenuSeparator />
                <ContextMenuItem variant="destructive" onSelect={() => onDialog('delete')} className="w-full gap-2 whitespace-nowrap"><Trash2 className="size-4" />{t('coworker.delete')}</ContextMenuItem>
            </ContextMenuContent>
        </ContextMenu> : header}
        {!collapsed && (members.length === 0
            ? <p data-simple-box-empty className="py-1.5 pl-7 text-xs text-muted-foreground/60">{t('workspaceView.list.emptyBox')}</p>
            : <ul className="space-y-0.5">{members.map(agent => <li key={agent.id}>{renderTile(agent)}</li>)}</ul>)}
    </section>
}

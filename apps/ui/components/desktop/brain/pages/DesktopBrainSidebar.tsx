'use client'

import { isCardType } from '@/lib/brain/labels'
import { BRAIN_PAGE_ICONS } from '@/lib/brain/page-icons'
import { BrainIcon, ChevronRightIcon, InboxIcon, PlusIcon, SearchIcon, type LucideIcon } from '@/lib/icons'
import { cn } from '@/lib/utils'
import type { BrainPageSummary } from '@rerun/contracts'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useMemo, useState, type ReactNode, type Ref } from 'react'
import type { DesktopBrainSelection } from './types'

type SidebarRowProps = {
    icon: LucideIcon
    label: string
    active: boolean
    depth?: number
    leading?: ReactNode
    trailing?: ReactNode
    tooltip?: string
    expanded?: boolean
    onClick: () => void
}

// The hosted sidebar's row, unchanged: same height, indentation and active ink.
function SidebarRow({ icon: Glyph, label, active, depth = 0, leading, trailing, tooltip, expanded, onClick }: SidebarRowProps) {
    return (
        <div
            role="button"
            tabIndex={0}
            aria-expanded={expanded}
            onClick={onClick}
            onKeyDown={event => {
                if (event.key !== 'Enter' && event.key !== ' ') return
                event.preventDefault()
                onClick()
            }}
            title={tooltip}
            style={{ paddingLeft: `${0.5 + depth * 0.875}rem` }}
            className={cn(
                'group/row flex h-7 w-full cursor-pointer items-center gap-1.5 rounded-md pr-1.5 text-left text-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/50',
                active ? 'bg-accent font-medium text-foreground' : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground',
            )}
        >
            {leading}
            <Glyph className="size-3.5 shrink-0" />
            <span className="min-w-0 flex-1 truncate">{label}</span>
            {trailing}
        </div>
    )
}

function SectionHeader({ label, action, active, onClick }: { label: string; action?: ReactNode; active?: boolean; onClick?: () => void }) {
    return (
        <div className="group/section flex h-7 items-center justify-between pl-2 pr-1 pt-3">
            {onClick ? (
                <button type="button" onClick={onClick} className={cn('-ml-1 rounded px-1 text-[11px] font-medium transition-colors hover:bg-accent hover:text-foreground', active ? 'text-foreground' : 'text-muted-foreground/80')}>
                    {label}
                </button>
            ) : (
                <span className="text-[11px] font-medium text-muted-foreground/80">{label}</span>
            )}
            {action && <div className="opacity-0 transition-opacity group-hover/section:opacity-100 has-[[aria-expanded=true]]:opacity-100 max-sm:opacity-100">{action}</div>}
        </div>
    )
}

export type DesktopBrainSidebarProps = {
    pages: BrainPageSummary[]
    /** False before the Brain exists on this box: the page list says so instead of looking empty. */
    pagesAvailable: boolean
    selection: DesktopBrainSelection | null
    openProposals: number
    searchRef: Ref<HTMLInputElement>
    onSelect: (selection: DesktopBrainSelection) => void
    /** Root passes a proposal slot when D's review panel is mounted. Without it there is no row. */
    proposalsAvailable: boolean
}

/**
 * The hosted sidebar without the two surfaces this panel does not own: the shared folder and the
 * shared database. Everything that is a page keeps the original section, fold and search behavior.
 */
export function DesktopBrainSidebar({ pages, pagesAvailable, selection, openProposals, searchRef, onSelect, proposalsAvailable }: DesktopBrainSidebarProps) {
    const [query, setQuery] = useState('')
    const card = pages.filter(page => isCardType(page.type))
    const products = pages.filter(page => page.type === 'product')
    const others = pages.filter(page => !isCardType(page.type) && page.type !== 'product')
    const [productsExpanded, setProductsExpanded] = useState<boolean | null>(null)

    const results = useMemo(() => {
        const needle = query.trim().toLowerCase()
        if (!needle) return null
        return pages.filter(page => page.title.toLowerCase().includes(needle) || page.slug.includes(needle))
    }, [query, pages])

    const isSelected = (page: BrainPageSummary) => (selection?.kind === 'page' || selection?.kind === 'history') && selection.slug === page.slug
    const productsOpen = productsExpanded ?? products.some(isSelected)

    const pageRow = (page: BrainPageSummary, depth = 0) => (
        <SidebarRow
            key={page.slug}
            icon={BRAIN_PAGE_ICONS[page.type]}
            label={page.title}
            depth={depth}
            leading={depth > 0 ? <span className="w-3.5 shrink-0" /> : undefined}
            active={isSelected(page)}
            onClick={() => onSelect({ kind: 'page', slug: page.slug })}
        />
    )

    return (
        <div className="flex h-full min-h-0 flex-col">
            <div className="space-y-2 px-2 pb-1 pt-3">
                <div className="flex items-center gap-2 px-2">
                    <BrainIcon className="size-4 shrink-0" />
                    <span className="text-sm font-semibold">Brain</span>
                </div>
                <div className="relative">
                    <SearchIcon className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                    <Input
                        ref={searchRef}
                        value={query}
                        onChange={event => setQuery(event.target.value)}
                        onKeyDown={event => event.key === 'Escape' && query && (event.stopPropagation(), setQuery(''))}
                        placeholder="Search pages"
                        aria-label="Search pages"
                        className="h-7 pl-8 text-sm"
                    />
                    <kbd className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-[10px] text-muted-foreground/70 max-sm:hidden">⌘K</kbd>
                </div>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
                {results ? (
                    <>
                        <SectionHeader label="Pages" />
                        {results.length ? results.map(page => pageRow(page)) : <p className="px-2 py-1 text-xs text-muted-foreground/70">No page matches</p>}
                    </>
                ) : (
                    <>
                        {proposalsAvailable && (
                            <div className="pt-1">
                                <SidebarRow
                                    icon={InboxIcon}
                                    label="Proposals"
                                    active={selection?.kind === 'proposals'}
                                    onClick={() => onSelect({ kind: 'proposals' })}
                                    trailing={openProposals > 0 && <span className="flex h-4 min-w-4 items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-medium text-white tabular-nums">{openProposals}</span>}
                                />
                            </div>
                        )}

                        <SectionHeader label="Company" />
                        {pagesAvailable ? card.map(page => pageRow(page)) : <p className="px-2 py-1 text-xs text-muted-foreground/70">Not on this box yet</p>}

                        {pagesAvailable && (
                            <>
                                <SectionHeader
                                    label="Pages"
                                    action={
                                        <Button size="icon-xs" variant="ghost" onClick={() => onSelect({ kind: 'new-page' })} aria-label="New page" title="New page">
                                            <PlusIcon />
                                        </Button>
                                    }
                                />
                                {products.length > 0 && (
                                    <>
                                        <SidebarRow
                                            icon={BRAIN_PAGE_ICONS.product}
                                            label="Products"
                                            active={false}
                                            expanded={productsOpen}
                                            leading={<ChevronRightIcon className={cn('-ml-0.5 size-3 shrink-0 transition-transform duration-150', productsOpen && 'rotate-90')} />}
                                            trailing={<span className="text-[11px] tabular-nums text-muted-foreground/70">{products.length}</span>}
                                            onClick={() => setProductsExpanded(!productsOpen)}
                                        />
                                        {productsOpen && products.map(page => pageRow(page, 1))}
                                    </>
                                )}
                                {others.map(page => pageRow(page))}
                                <SidebarRow icon={PlusIcon} label="New page" active={selection?.kind === 'new-page'} onClick={() => onSelect({ kind: 'new-page' })} />
                            </>
                        )}
                    </>
                )}
            </div>
        </div>
    )
}

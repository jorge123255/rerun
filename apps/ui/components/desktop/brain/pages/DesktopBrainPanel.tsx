'use client'

import { BrainChromeContext, BrainTopBar } from '@/components/brain/BrainTopBar'
import { EmptyState } from '@/components/ui/empty-state'
import { PanelSteps } from '@/components/ui/panel-steps'
import { Button } from '@/components/ui/button'
import { Skeleton, SkeletonList } from '@/components/ui/skeleton'
import { flushDesktopBrainDrafts, type BrainPageDetail } from '@/lib/desktop/use-brain-page-draft'
import { BrainIcon, PanelLeftIcon, RefreshCwIcon } from '@/lib/icons'
import { cn } from '@/lib/utils'
import type { BrainPageSummary } from '@rerun/contracts'
import { useIsMobile } from '@rerun/ui/primitives/use-is-mobile'
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { toast } from 'sonner'
import { DesktopBrainHistory } from './DesktopBrainHistory'
import { DesktopBrainNewPage } from './DesktopBrainNewPage'
import { DesktopBrainPage } from './DesktopBrainPage'
import { DesktopBrainSidebar } from './DesktopBrainSidebar'
import type { DesktopBrainActions, DesktopBrainOverview, DesktopBrainSelection } from './types'

type PageState = { slug: string; detail: BrainPageDetail | null; missing: boolean; version: number }

function PageSkeleton() {
    return (
        <>
            <div className="flex h-12 shrink-0 items-center px-4">
                <Skeleton className="h-3 w-40" />
            </div>
            <div className="mx-auto w-full max-w-[720px] px-6 pt-8 sm:px-12 sm:pt-12">
                <Skeleton className="mb-4 size-12 rounded-xl" />
                <Skeleton className="h-8 w-1/2" />
                <div className="mt-6 space-y-2">
                    <Skeleton className="h-3 w-1/3" />
                    <Skeleton className="h-3 w-1/4" />
                </div>
                <div className="mt-10 space-y-3">
                    <Skeleton className="h-3 w-full" />
                    <Skeleton className="h-3 w-5/6" />
                    <Skeleton className="h-3 w-2/3" />
                </div>
            </div>
        </>
    )
}

const toSummary = ({ slug, title, type, hash, updatedAt, updatedBy }: BrainPageDetail['page']): BrainPageSummary => ({ slug, title, type, hash, updatedAt, updatedBy })

/**
 * The Company Brain as one self-contained panel: the hosted sidebar and page column, over an
 * injected actions interface, with the shared folder, the shared database and website seeding left
 * out because this build does not own them.
 *
 * Every read is guarded against a slower earlier one landing on top, and every write is either
 * acknowledged by the store or shown as not saved. Root mounts this, decides where it opens and
 * owns cross-panel navigation; nothing here talks to an engine, a server action or an account.
 */
export function DesktopBrainPanel({ actions, onClose, renderProposals, openSlug, onOpenConsumed }: {
    actions: DesktopBrainActions
    onClose: () => void
    /** D's review panel, when root mounts it. Without a slot there is no Proposals row. */
    renderProposals?: () => ReactNode
    /** A page another panel asked to open, consumed once. */
    openSlug?: string | null
    onOpenConsumed?: () => void
}) {
    const isMobile = useIsMobile()
    const [overview, setOverview] = useState<DesktopBrainOverview | null>(null)
    const [selection, setSelection] = useState<DesktopBrainSelection | null>(null)
    const [pageState, setPageState] = useState<PageState | null>(null)
    const [sidebarOpen, setSidebarOpen] = useState(false)
    const searchRef = useRef<HTMLInputElement>(null)
    const selectionRef = useRef(selection)
    useEffect(() => { selectionRef.current = selection })

    const pages = useMemo(() => (overview?.available ? overview.pages : []), [overview])
    const titles = useMemo(() => new Map(pages.map(page => [page.slug, page.title])), [pages])
    const available = overview?.available ?? false
    const offline = overview && !overview.available ? overview.reason : null

    const reloadOverview = useCallback(async (): Promise<DesktopBrainOverview> => {
        const next = await actions.overview().catch(() => ({ available: false, reason: 'unreachable' }) as const)
        setOverview(next)
        return next
    }, [actions])

    const readSeq = useRef(0)
    const loadPage = useCallback(async (slug: string) => {
        const seq = ++readSeq.current
        setPageState(current => (current?.slug === slug ? current : { slug, detail: null, missing: false, version: 0 }))
        // A page just left may still be writing: read after it lands, never before.
        await flushDesktopBrainDrafts()
        const detail = await actions.readPage(slug).catch(() => null)
        if (seq !== readSeq.current) return
        setPageState(current => ({ slug, detail, missing: !detail, version: (current?.slug === slug ? current.version : 0) + 1 }))
    }, [actions])

    const select = useCallback((next: DesktopBrainSelection) => {
        if (next.kind === 'page' && selectionRef.current?.kind === 'page' && selectionRef.current.slug === next.slug) {
            setSidebarOpen(false)
            return
        }
        setSelection(next)
        setSidebarOpen(false)
        if (next.kind === 'page') void loadPage(next.slug)
    }, [loadPage])

    const loadWorkspace = useCallback(() => reloadOverview().then(next => {
        if (selectionRef.current) return next
        if (next.available && next.pages[0]) select({ kind: 'page', slug: next.pages[0].slug })
        return next
    }), [reloadOverview, select])

    useEffect(() => {
        // eslint-disable-next-line react-hooks/set-state-in-effect
        void loadWorkspace()
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [])

    useEffect(() => {
        if (!openSlug) return
        select({ kind: 'page', slug: openSlug })
        onOpenConsumed?.()
    }, [openSlug, select, onOpenConsumed])

    useEffect(() => {
        const onKey = (event: KeyboardEvent) => {
            if (event.key?.toLowerCase() !== 'k' || !(event.metaKey || event.ctrlKey)) return
            event.preventDefault()
            event.stopPropagation()
            setSidebarOpen(true)
            searchRef.current?.focus()
            searchRef.current?.select()
        }
        window.addEventListener('keydown', onKey, true)
        return () => window.removeEventListener('keydown', onKey, true)
    }, [])

    const openPage = useCallback((slug: string) => select({ kind: 'page', slug }), [select])

    const savedPage = useCallback((detail: BrainPageDetail) => {
        setPageState(current => (current?.slug === detail.page.slug ? { ...current, detail, missing: false } : current))
        setOverview(current => {
            if (!current?.available) return current
            const summary = toSummary(detail.page)
            const known = current.pages.some(page => page.slug === summary.slug)
            return { ...current, pages: known ? current.pages.map(page => (page.slug === summary.slug ? summary : page)) : [...current.pages, summary] }
        })
    }, [])

    const createdPage = useCallback((detail: BrainPageDetail) => {
        savedPage(detail)
        setPageState({ slug: detail.page.slug, detail, missing: false, version: 1 })
        setSelection({ kind: 'page', slug: detail.page.slug })
        void reloadOverview()
    }, [savedPage, reloadOverview])

    const deletePage = useCallback(async (slug: string) => {
        const result = await actions.deletePage(slug).catch(cause => ({ ok: false as const, error: cause instanceof Error && cause.message ? cause.message : 'Could not delete the page' }))
        if (!result.ok) {
            // Nothing is pretended: the page stays open and the failure is said out loud.
            toast.error(result.error || 'Could not delete the page')
            return
        }
        const next = await reloadOverview()
        const fallback = next.available ? next.pages.find(page => page.slug !== slug)?.slug : undefined
        if (fallback) select({ kind: 'page', slug: fallback })
        else {
            setSelection(null)
            setPageState(null)
        }
    }, [actions, reloadOverview, select])

    const restoredPage = useCallback((detail: BrainPageDetail) => {
        setPageState(current => ({ slug: detail.page.slug, detail, missing: false, version: (current?.version ?? 0) + 1 }))
        setSelection({ kind: 'page', slug: detail.page.slug })
        void reloadOverview()
    }, [reloadOverview])

    const chrome = useMemo(() => ({ onClose, onToggleSidebar: isMobile && !offline ? () => setSidebarOpen(true) : null }), [onClose, isMobile, offline])

    const renderMain = () => {
        if (!overview) return <PageSkeleton />
        if (offline) {
            return (
                <>
                    <BrainTopBar crumbs={[{ label: 'Brain', icon: BrainIcon }]} />
                    {offline === 'no_machine' ? (
                        <EmptyState
                            icon={BrainIcon}
                            title="Your Brain comes with your first coworker"
                            description="It lives on the machine of this workspace, which exists once a coworker does. From then on, what every coworker knows about your company shows up here."
                        />
                    ) : offline === 'outdated' ? (
                        <EmptyState
                            icon={BrainIcon}
                            title="This machine does not have the Brain yet"
                            description="The local engine answered, but without the Brain pages. Update the engine, then open this panel again."
                        />
                    ) : (
                        <EmptyState
                            icon={BrainIcon}
                            title="Could not reach your workspace"
                            description="The local engine did not answer. It may still be starting."
                            action={<Button size="sm" variant="outline" onClick={() => { void loadWorkspace() }}><RefreshCwIcon className="size-3.5" /> Retry</Button>}
                        />
                    )}
                </>
            )
        }
        if (!selection) {
            if (available && pages.length === 0) {
                return (
                    <>
                        <BrainTopBar crumbs={[{ label: 'Company' }]} />
                        <EmptyState
                            icon={BrainIcon}
                            title="Your company brain is empty"
                            description="It is what every coworker reads about your company before it works: what you sell, to whom, your team, your voice and your tools."
                            action={<Button size="sm" onClick={() => select({ kind: 'new-page' })}>Write the first page</Button>}
                        />
                    </>
                )
            }
            return <BrainTopBar crumbs={[{ label: 'Brain', icon: BrainIcon }]} />
        }
        switch (selection.kind) {
            case 'page': {
                if (pageState?.slug !== selection.slug || (!pageState.detail && !pageState.missing)) return <PageSkeleton />
                if (!pageState.detail) {
                    return (
                        <>
                            <BrainTopBar crumbs={[{ label: 'Pages' }, { label: selection.slug }]} />
                            <EmptyState icon={BrainIcon} title={`No page "${selection.slug}" yet`} description="A link points here, but nothing has been written on this page." />
                        </>
                    )
                }
                const detail = pageState.detail
                return (
                    <DesktopBrainPage
                        key={`${detail.page.slug}:${pageState.version}`}
                        detail={detail}
                        pages={pages}
                        titles={titles}
                        actions={actions}
                        onOpenPage={openPage}
                        onSaved={savedPage}
                        onHistory={() => setSelection({ kind: 'history', slug: detail.page.slug })}
                        onDeleted={deletePage}
                    />
                )
            }
            case 'history': {
                const detail = pageState?.slug === selection.slug ? pageState.detail : null
                if (!detail) return <PageSkeleton />
                return (
                    <DesktopBrainHistory
                        page={detail.page}
                        revisions={detail.revisions}
                        titles={titles}
                        actions={actions}
                        onBack={() => setSelection({ kind: 'page', slug: selection.slug })}
                        onOpenPage={openPage}
                        onRestored={restoredPage}
                    />
                )
            }
            case 'new-page':
                return <DesktopBrainNewPage pages={pages} titles={titles} actions={actions} onOpenPage={openPage} onCreated={createdPage} />
            case 'proposals':
                return renderProposals ? <>{renderProposals()}</> : <BrainTopBar crumbs={[{ label: 'Brain', icon: BrainIcon }]} />
        }
    }

    return (
        <BrainChromeContext.Provider value={chrome}>
            <div data-desktop-brain className="relative flex min-h-0 flex-1">
                {isMobile && sidebarOpen && !offline && <div className="absolute inset-0 z-20 bg-black/20" onClick={() => setSidebarOpen(false)} aria-hidden />}
                {!offline && (
                    <aside
                        className={cn(
                            'flex w-[248px] shrink-0 flex-col border-r border-border bg-muted/30',
                            isMobile && 'absolute inset-y-0 left-0 z-30 w-[85%] max-w-[300px] bg-popover shadow-xl transition-transform duration-200',
                            isMobile && !sidebarOpen && '-translate-x-full',
                        )}
                    >
                        {overview ? (
                            <DesktopBrainSidebar
                                pages={pages}
                                pagesAvailable={available}
                                selection={selection}
                                openProposals={overview.available ? overview.openProposals : 0}
                                searchRef={searchRef}
                                onSelect={select}
                                proposalsAvailable={Boolean(renderProposals)}
                            />
                        ) : (
                            <div className="space-y-3 p-3">
                                <Skeleton className="h-5 w-20" />
                                <Skeleton className="h-7 w-full" />
                                <SkeletonList rows={8} />
                            </div>
                        )}
                    </aside>
                )}

                <main className="flex min-h-0 min-w-0 flex-1 flex-col bg-background">
                    {isMobile && !offline && (
                        <div className="flex h-9 shrink-0 items-center px-2">
                            <Button size="icon-sm" variant="ghost" onClick={() => setSidebarOpen(true)} aria-label="Show pages" title="Show pages">
                                <PanelLeftIcon />
                            </Button>
                        </div>
                    )}
                    <PanelSteps stepKey={selection ? JSON.stringify(selection) : 'brain'} depth={selection?.kind === 'history' ? 2 : 1}>
                        {renderMain()}
                    </PanelSteps>
                </main>
            </div>
        </BrainChromeContext.Provider>
    )
}

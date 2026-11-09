'use client'

import { BrainSidebar } from '@/components/brain/BrainSidebar'
import { selectionDepth, selectionKey, type BrainSelection } from '@/components/brain/selection'
import { BrainChromeContext, BrainTopBar } from '@/components/brain/BrainTopBar'
import type { SharedFilesTree } from '@/components/brain/useSharedFilesTree'
import { DataBrowser } from '@/components/data/DataBrowser'
import { EmptyState } from '@/components/ui/empty-state'
import { PanelSteps } from '@/components/ui/panel-steps'
import { Button } from '@/components/ui/button'
import { Skeleton, SkeletonList } from '@/components/ui/skeleton'
import { DesktopBrainFile, DesktopBrainFolder } from '@/components/desktop/brain/files/DesktopBrainFiles'
import { useDesktopSharedFilesTree } from '@/components/desktop/brain/files/useDesktopSharedFilesTree'
import type { DataFocus } from '@/lib/data/source'
import { humanizeTableName } from '@/lib/data/table-name'
import { DesktopBrainRequestError, type DesktopBrainOverview as PagesOverview } from '@/lib/desktop/brain-pages'
import { desktopDataSource } from '@/lib/desktop/data-source'
import { holdDraftAdmission, isDesktopQuitting } from '@/lib/desktop/draft-writes'
import { importDesktopSharedFile } from '@/lib/desktop/shared-workspace-files'
import { flushDesktopBrainDrafts, forgetBrainDraft, brainDraftHash, type BrainPageDetail } from '@/lib/desktop/use-brain-page-draft'
import type { EngineDbTable } from '@/lib/engine/types'
import type { UploadEntry } from '@/lib/files/upload'
import { BrainIcon, DatabaseIcon, PanelLeftIcon, RefreshCwIcon, TableIcon } from '@/lib/icons'
import { cn } from '@/lib/utils'
import type { BrainPageSummary } from '@rerun/contracts'
import { useIsMobile } from '@rerun/ui/primitives/use-is-mobile'
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { toast } from 'sonner'
import { brainMutationIntent, reserveBrainMutation, settleBrainMutation } from './mutation-intents'
import { DesktopBrainHistory } from './DesktopBrainHistory'
import { DesktopBrainNewPage } from './DesktopBrainNewPage'
import { DesktopBrainPage } from './DesktopBrainPage'
import { authorizedSharedFilePath, linkableSharedFiles } from './shared-file-link'
import type { DesktopBrainActions, DesktopBrainOverview, DesktopBrainRoute } from './types'

type PageState = { slug: string; detail: BrainPageDetail | null; missing: boolean; error?: string; version: number }

const SHARED_TABLES_EMPTY = {
    title: 'No shared tables yet',
    description: 'Every coworker of the workspace reads and writes this database. When they need a common record (a catalog, a queue, a list several coworkers work through), they create tables here that you can browse anytime.',
}

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

function toOverview(loaded: unknown): DesktopBrainOverview {
    if (loaded && typeof loaded === 'object' && 'available' in loaded && (loaded as { available: unknown }).available === false) {
        const reason = (loaded as { reason?: unknown }).reason
        if (reason === 'no_machine' || reason === 'outdated' || reason === 'unreachable') return { available: false, reason }
    }
    const success = loaded as PagesOverview
    return { available: true, pages: success.pages, openProposals: success.openProposals }
}

/**
 * Company Brain as one panel: the original sidebar (proposals, pages, shared files, shared database)
 * and the desktop body for whatever is selected.
 *
 * Page reads still wait for `flushDesktopBrainDrafts`. A selection made before the overview returns
 * stays put. A route table wins over a page request. Root mounts the dialog; this panel does not
 * wire Control Center or a hosted workspace. Page editors receive the files listed so far, and a
 * file link opens only when that path is one of them.
 */
export function DesktopBrainPanel({ actions, onClose, renderProposals, openSlug, onOpenConsumed, refreshKey, openProposalsKey, route, onRouteConsumed, files: filesProp, onUpload }: {
    actions: DesktopBrainActions
    onClose: () => void
    /** D's review panel, when root mounts it. The Proposals row stays either way. */
    renderProposals?: () => ReactNode
    /** A page another panel asked to open, consumed once. A route table wins over this. */
    openSlug?: string | null
    onOpenConsumed?: () => void
    refreshKey?: number
    openProposalsKey?: number
    route?: DesktopBrainRoute | null
    onRouteConsumed?: () => void
    /** Tests pass a tree. The panel otherwise lists the shared folder itself. */
    files?: SharedFilesTree
    /** Tests pass an upload. The panel otherwise calls `importDesktopSharedFile`. */
    onUpload?: (entries: UploadEntry[], dir: string) => void
}) {
    const isMobile = useIsMobile()
    const listedFiles = useDesktopSharedFilesTree()
    const files = filesProp ?? listedFiles
    const [overview, setOverview] = useState<DesktopBrainOverview | null>(null)
    const [selection, setSelection] = useState<BrainSelection | null>(null)
    const [pageState, setPageState] = useState<PageState | null>(null)
    const [sidebarOpen, setSidebarOpen] = useState(false)
    const [dataFocus, setDataFocus] = useState<DataFocus | null>(null)
    const [tables, setTables] = useState<EngineDbTable[] | null>(null)
    const [tablesError, setTablesError] = useState<string | null>(null)
    const searchRef = useRef<HTMLInputElement>(null)
    const selectionRef = useRef(selection)
    useEffect(() => { selectionRef.current = selection })
    const dataSource = useMemo(() => desktopDataSource({ kind: 'shared' }), [])

    const pages = useMemo(() => (overview?.available ? overview.pages : []), [overview])
    const titles = useMemo(() => new Map(pages.map(page => [page.slug, page.title])), [pages])
    const available = overview?.available ?? false
    const offline = overview && !overview.available && overview.reason !== 'outdated' ? overview.reason : null

    const overviewSeq = useRef(0)
    const reloadOverview = useCallback(async (): Promise<DesktopBrainOverview> => {
        const seq = ++overviewSeq.current
        let loaded: unknown
        try { loaded = await actions.load() }
        catch (error) {
            // A box from before the Brain answers 404 on the pages route. Files and the database still exist.
            loaded = error instanceof DesktopBrainRequestError && error.status === 404
                ? { available: false, reason: 'outdated' }
                : { available: false, reason: 'unreachable' }
        }
        const next = toOverview(loaded)
        if (seq === overviewSeq.current) setOverview(next)
        return next
    }, [actions])

    const reloadTables = useCallback(async () => {
        try {
            const list = await dataSource.listTables()
            setTables(list)
            setTablesError(null)
            return list
        } catch (error) {
            setTables([])
            setTablesError(error instanceof Error && error.message ? error.message : 'Could not reach the workspace database.')
            return []
        }
    }, [dataSource])

    const readSeq = useRef(0)
    const loadPage = useCallback(async (slug: string, draftsFlushed = false) => {
        const seq = ++readSeq.current
        setPageState(current => (current?.slug === slug ? current : { slug, detail: null, missing: false, version: 0 }))
        // A page just left may still be writing: read after it lands, never before.
        if (!draftsFlushed) await flushDesktopBrainDrafts()
        try {
            const detail = await actions.readPage(slug)
            if (seq !== readSeq.current) return
            setPageState(current => ({ slug, detail, missing: !detail, version: (current?.slug === slug ? current.version : 0) + 1 }))
        } catch (error) {
            if (seq !== readSeq.current) return
            setPageState(current => ({ slug, detail: current?.slug === slug ? current.detail : null, missing: false,
                version: current?.slug === slug ? current.version : 0, error: error instanceof Error ? error.message : 'Could not read this page. Try again.' }))
        }
    }, [actions])

    const commitSelection = useCallback((next: BrainSelection | null) => {
        selectionRef.current = next
        setSelection(next)
    }, [])

    const navigation = useRef(0)
    useEffect(() => () => { navigation.current++ }, [])
    const select = useCallback((next: BrainSelection) => {
        const previous = selectionRef.current
        const request = ++navigation.current
        if (next.kind === 'page' && previous?.kind === 'page' && previous.slug === next.slug) {
            setSidebarOpen(false)
            return
        }
        const show = (draftsFlushed: boolean) => {
            if (navigation.current !== request || selectionRef.current !== previous || isDesktopQuitting()) return
            commitSelection(next)
            setSidebarOpen(false)
            if (next.kind === 'page') void loadPage(next.slug, draftsFlushed)
        }
        if (previous?.kind !== 'page') { show(false); return }
        void flushDesktopBrainDrafts().catch(() => false).then(flushed => {
            if (flushed) show(true)
            else if (navigation.current === request && selectionRef.current === previous) {
                toast.error('Some edits could not be saved. Resolve them before leaving this page.')
            }
        })
    }, [commitSelection, loadPage])

    const loadWorkspace = useCallback(() => {
        void reloadTables()
        return reloadOverview().then(next => {
            if (selectionRef.current) return next
            if (next.available && next.pages[0]) select({ kind: 'page', slug: next.pages[0].slug })
            else if (!next.available && next.reason === 'outdated') select({ kind: 'folder', path: '' })
            return next
        })
    }, [reloadTables, reloadOverview, select])

    const consumeRoute = useCallback((incoming: DesktopBrainRoute) => {
        setDataFocus(incoming.data ?? null)
        if (incoming.data?.table) select({ kind: 'table', name: incoming.data.table })
        else if (incoming.selection) select(incoming.selection)
        onRouteConsumed?.()
    }, [select, onRouteConsumed])

    const mountRoute = useRef(route)
    useEffect(() => {
        if (mountRoute.current && (mountRoute.current.data?.table || mountRoute.current.selection)) consumeRoute(mountRoute.current)
        void loadWorkspace()
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [])

    useEffect(() => {
        if (!route || route === mountRoute.current) return
        consumeRoute(route)
    }, [route, consumeRoute])

    useEffect(() => {
        if (!openSlug) return
        if (route?.data?.table) { onOpenConsumed?.(); return }
        select({ kind: 'page', slug: openSlug })
        onOpenConsumed?.()
    }, [openSlug, route?.data?.table, select, onOpenConsumed])

    useEffect(() => {
        if (refreshKey === undefined) return
        void reloadOverview()
        const selected = selectionRef.current
        if (selected?.kind === 'page' || selected?.kind === 'history') void loadPage(selected.slug)
    }, [refreshKey, reloadOverview, loadPage])

    const consumedProposalsKey = useRef<number | undefined>(undefined)
    useEffect(() => {
        if (!openProposalsKey || !renderProposals || consumedProposalsKey.current === openProposalsKey) return
        consumedProposalsKey.current = openProposalsKey
        if (route?.data?.table) return
        select({ kind: 'proposals' })
    }, [openProposalsKey, select, renderProposals, route?.data?.table])

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

    useEffect(() => {
        if (selection?.kind !== 'database' || !tables?.[0]) return
        select({ kind: 'table', name: tables[0].name })
    }, [selection, tables, select])

    const refreshListed = files.refresh
    const uploadFiles = useCallback(async (entries: UploadEntry[], dir: string) => {
        if (onUpload) { onUpload(entries, dir); return }
        if (isDesktopQuitting()) return
        const release = holdDraftAdmission()
        try {
            for (const entry of entries) {
                if (isDesktopQuitting()) break
                const folder = [dir, entry.subDir].filter(Boolean).join('/')
                try { await importDesktopSharedFile(folder, entry.file) }
                catch (error) { toast.error(error instanceof Error && error.message ? error.message : `Could not import ${entry.file.name}.`) }
            }
            await refreshListed(dir)
        } finally { release() }
    }, [onUpload, refreshListed])

    const openPage = useCallback((slug: string) => select({ kind: 'page', slug }), [select])
    const linkableFiles = useMemo(() => linkableSharedFiles(files.knownFiles), [files.knownFiles])
    const openListedFile = useCallback((path: string) => {
        const allowed = authorizedSharedFilePath(path, linkableFiles)
        if (!allowed) return
        select({ kind: 'file', path: allowed })
    }, [linkableFiles, select])

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
        commitSelection({ kind: 'page', slug: detail.page.slug })
        void reloadOverview()
    }, [savedPage, reloadOverview, commitSelection])

    const deletePage = useCallback(async (slug: string) => {
        try {
            if (!await flushDesktopBrainDrafts()) throw new Error('Save or resolve your page edits before deleting.')
            const expectedHash = brainDraftHash(slug) ?? (pageState?.slug === slug ? pageState.detail?.page.hash : undefined)
            const existing = brainMutationIntent('delete:' + slug)
            if (!existing && !expectedHash) throw new Error('Reload this page before deleting it.')
            const pending = existing ?? await reserveBrainMutation('delete:' + slug, { kind: 'delete', slug, expectedHash: expectedHash! })
            if (pending.input.kind !== 'delete' || pending.input.slug !== slug) throw new Error('The saved delete request does not match this page.')
            const result = await actions.deletePage(slug, pending.input.expectedHash, pending.requestId)
            await settleBrainMutation('delete:' + slug, result)
            if (!result.ok) throw new Error(result.error)
            forgetBrainDraft(slug)
            const next = await reloadOverview()
            const fallback = next.available ? next.pages.find(page => page.slug !== slug)?.slug : undefined
            if (fallback) select({ kind: 'page', slug: fallback })
            else { commitSelection(null); setPageState(null) }
        } catch (error) { toast.error(error instanceof Error ? error.message : 'Could not delete this page. Try again.') }
    }, [actions, pageState, reloadOverview, select, commitSelection])

    const restoredPage = useCallback((detail: BrainPageDetail) => {
        forgetBrainDraft(detail.page.slug)
        setPageState(current => ({ slug: detail.page.slug, detail, missing: false, version: (current?.version ?? 0) + 1 }))
        commitSelection({ kind: 'page', slug: detail.page.slug })
        void reloadOverview()
    }, [reloadOverview, commitSelection])

    const tableDropped = useCallback(async (name: string) => {
        const remaining = await reloadTables()
        const next = remaining.find(table => table.name !== name)
        select(next ? { kind: 'table', name: next.name } : { kind: 'database' })
    }, [reloadTables, select])

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
                    ) : (
                        <EmptyState
                            icon={BrainIcon}
                            title="Could not reach your workspace"
                            description="The local engine did not answer. It may still be starting."
                            action={<Button size="sm" variant="outline" onClick={() => {
                                void files.refresh('')
                                void loadWorkspace().then(next => {
                                    const current = selectionRef.current
                                    if (next.available && current?.kind === 'page') void loadPage(current.slug)
                                })
                            }}><RefreshCwIcon className="size-3.5" /> Retry</Button>}
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
                if (pageState?.slug !== selection.slug || (!pageState.detail && !pageState.missing && !pageState.error)) return <PageSkeleton />
                if (pageState.error) return <><BrainTopBar crumbs={[{ label: 'Pages' }, { label: selection.slug }]} /><EmptyState icon={BrainIcon}
                    title="Could not read this page" description={pageState.error}
                    action={<Button size="sm" onClick={() => void loadPage(selection.slug)}>Retry</Button>} /></>
                if (!pageState.detail) {
                    return (
                        <>
                            <BrainTopBar crumbs={[{ label: 'Pages' }, { label: selection.slug }]} />
                            <EmptyState icon={BrainIcon} title={`No page "${selection.slug}" yet`} description="A link points here, but nothing has been written on this page."
                                action={<Button size="sm" variant="outline" onClick={() => { try { if (brainMutationIntent('delete:' + selection.slug)) void deletePage(selection.slug); else void loadPage(selection.slug) } catch (error) { toast.error(error instanceof Error ? error.message : 'Could not read the pending request.') } }}>Retry</Button>} />
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
                        files={linkableFiles}
                        actions={actions}
                        onOpenPage={openPage}
                        onOpenFile={openListedFile}
                        onSaved={savedPage}
                        onHistory={() => commitSelection({ kind: 'history', slug: detail.page.slug })}
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
                        onBack={() => commitSelection({ kind: 'page', slug: selection.slug })}
                        onOpenPage={openPage}
                        onOpenFile={openListedFile}
                        onRestored={restoredPage}
                    />
                )
            }
            case 'new-page':
                return <DesktopBrainNewPage pages={pages} titles={titles} files={linkableFiles} actions={actions} onOpenPage={openPage} onOpenFile={openListedFile} onCreated={createdPage} />
            case 'proposals':
                return renderProposals ? <>{renderProposals()}</> : <BrainTopBar crumbs={[{ label: 'Brain', icon: BrainIcon }]} />
            case 'folder':
                return <DesktopBrainFolder path={selection.path} files={files} onSelect={select} onUpload={uploadFiles} />
            case 'file':
                return <DesktopBrainFile path={selection.path} files={files} onSelect={select} />
            case 'database':
                if (!tables || tables.length > 0) return <PageSkeleton />
                return (
                    <>
                        <BrainTopBar crumbs={[{ label: 'Database', icon: DatabaseIcon }]} />
                        {tablesError ? (
                            <EmptyState icon={DatabaseIcon} title="Database unavailable" description={tablesError} />
                        ) : (
                            <EmptyState icon={DatabaseIcon} title={SHARED_TABLES_EMPTY.title} description={SHARED_TABLES_EMPTY.description} />
                        )}
                    </>
                )
            case 'table': {
                const name = selection.name
                const crumbs = [
                    { label: 'Database', icon: DatabaseIcon },
                    { label: humanizeTableName(name), icon: TableIcon },
                ]
                if (tables && !tables.some(table => table.name === name)) {
                    return (
                        <>
                            <BrainTopBar crumbs={crumbs} />
                            <EmptyState icon={TableIcon} title={`No table "${name}"`} description="It may have been deleted, or the coworker that mentioned it has not created it yet." />
                        </>
                    )
                }
                return (
                    <>
                        <BrainTopBar crumbs={crumbs} />
                        <div className="flex min-h-0 flex-1 flex-col border-t border-border">
                            <DataBrowser
                                key={name}
                                source={dataSource}
                                table={name}
                                initial={dataFocus?.table === name ? dataFocus : null}
                                onInitialConsumed={() => setDataFocus(null)}
                                onTableDropped={() => void tableDropped(name)}
                            />
                        </div>
                    </>
                )
            }
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
                            <BrainSidebar
                                pages={pages}
                                pagesAvailable={available}
                                selection={selection}
                                openProposals={overview.available ? overview.openProposals : 0}
                                files={files}
                                tables={tables}
                                searchRef={searchRef}
                                onSelect={select}
                                onUpload={uploadFiles}
                                fileDrag={false}
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
                    <PanelSteps stepKey={selectionKey(selection)} depth={selectionDepth(selection)}>
                        {renderMain()}
                    </PanelSteps>
                </main>
            </div>
        </BrainChromeContext.Provider>
    )
}

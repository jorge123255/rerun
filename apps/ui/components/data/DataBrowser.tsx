'use client'

import { DeleteTableDialog } from '@/components/dialogs/DeleteTableDialog'
import { PurgeTableDialog } from '@/components/dialogs/PurgeTableDialog'
import { ViewSettingsDialog } from '@/components/dialogs/ViewSettingsDialog'
import { DataBrowserPagination } from '@/components/data/DataBrowserPagination'
import { DataBrowserTable, rowKey, type DbRow } from '@/components/data/DataBrowserTable'
import { DataBrowserToolbar } from '@/components/data/DataBrowserToolbar'
import { DataViewBar } from '@/components/data/DataViewBar'
import { LeadSourcesSheet } from '@/components/data/sources/LeadSourcesSheet'
import { ViewBoard } from '@/components/data/views/ViewBoard'
import { ViewGallery } from '@/components/data/views/ViewGallery'
import { ViewList } from '@/components/data/views/ViewList'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { EmptyState } from '@/components/ui/empty-state'
import { Skeleton, SkeletonTable } from '@/components/ui/skeleton'
import { friendlyColumns, gridColumns } from '@/lib/data/friendly-columns'
import type { DataFocus, DataSource, SqlValue } from '@/lib/data/source'
import { humanizeTableName } from '@/lib/data/table-name'
import { quickViewInput } from '@/lib/data/view-form'
import { ALL_ROWS, coerceCellInput, findView, readLastView, writeLastView } from '@/lib/data/views'
import type { EngineDbRows, EngineDbTable } from '@/lib/engine/types'
import { CheckIcon, ChevronDownIcon, DatabaseIcon, TableIcon } from '@/lib/icons'
import { cn } from '@/lib/utils'
import type { CardLayout, TableView } from '@rerun/contracts'
import type { CellContext } from '@rerun/ui/chat'
import { type ColumnDef, type SortingState, getCoreRowModel, useReactTable } from '@tanstack/react-table'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'

type DataBrowserProps = {
    source: DataSource
    /** Table, and view, a card in chat asked to land on. Captured at mount and honoured once. */
    initial?: DataFocus | null
    /** Chat cards supply a resolved view id and require it; ordinary opens may restore a preferred view. */
    requireInitialView?: boolean
    onInitialConsumed?: () => void
    /** Opens the same table and view somewhere larger. */
    onExpand?: (focus: DataFocus) => void
    /** Shows this one table, with no picker: the caller lists the tables itself. */
    table?: string
    onTableDropped?: () => void
}

type ViewDialog = { open: boolean; generation: number; view?: TableView; layout?: CardLayout }
type BrowserScope = { source: DataSource; table: string | null }
type OpenDetail = { source: DataSource; table: string; key: string | null; row: DbRow }

export function DataBrowser({ source, initial, requireInitialView = false, onInitialConsumed, onExpand, table: pinnedTable, onTableDropped }: DataBrowserProps) {
    const [requested] = useState(() => initial ?? null)
    const requestedTableRef = useRef(requested?.table ?? null)
    const requestedViewRef = useRef(requested?.view)
    const [tables, setTables] = useState<EngineDbTable[]>([])
    const [selected, setSelected] = useState<string | null>(null)
    const [data, setData] = useState<EngineDbRows | null>(null)
    const [pageIndex, setPageIndex] = useState(0)
    const [pageSize, setPageSize] = useState(25)
    const [sorting, setSorting] = useState<SortingState>([])
    const [search, setSearch] = useState('')
    const [query, setQuery] = useState('')
    const [loadingTables, setLoadingTables] = useState(true)
    const [loadingRows, setLoadingRows] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [initialTargetError, setInitialTargetError] = useState<string | null>(null)
    const [selectedRowIds, setSelectedRowIds] = useState<Set<string>>(new Set())
    const [refreshKey, setRefreshKey] = useState(0)
    const [rowsRefreshKey, setRowsRefreshKey] = useState(0)
    const [tableDialogOpen, setTableDialogOpen] = useState(false)
    const [purgeDialogOpen, setPurgeDialogOpen] = useState(false)
    const [busy, setBusy] = useState(false)
    const [actionError, setActionError] = useState<string | null>(null)
    const exportRequest = useRef<AbortController | null>(null)
    useEffect(() => () => { exportRequest.current?.abort(); exportRequest.current = null }, [source, selected])
    const [views, setViews] = useState<TableView[]>([])
    const [viewsError, setViewsError] = useState<string | null>(null)
    const [preferenceError, setPreferenceError] = useState<string | null>(null)
    const viewSelection = useRef(0)
    // Null until the views of the selected table are in: the rows wait for them, since the view
    // picks their order.
    const [activeId, setActiveId] = useState<string | null>(null)
    const [viewDialog, setViewDialog] = useState<ViewDialog>({ open: false, generation: 0 })
    const [addingView, setAddingView] = useState(false)
    const [viewsRefreshKey, setViewsRefreshKey] = useState(0)
    const mounted = useRef(false)
    useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
    const scopeRef = useRef<BrowserScope>({ source, table: selected })
    const scopeSequence = useRef(0)
    if (scopeRef.current.source !== source || scopeRef.current.table !== selected) {
        scopeRef.current = { source, table: selected }
        scopeSequence.current++
    }
    const scope = scopeRef.current
    const currentScope = () => mounted.current && scopeRef.current === scope
    const sameOwner = () => mounted.current && scopeRef.current.source === source && scopeRef.current.table === selected
    const dialogRef = useRef(viewDialog)
    dialogRef.current = viewDialog
    const activeIdRef = useRef(activeId)
    activeIdRef.current = activeId
    const tableRead = useRef(0)
    // The kind of each column is read from the first page of a table and view, then kept, so a
    // column does not change looks from one page to the next.
    const [kindSample, setKindSample] = useState<{ key: string; rows: DbRow[] } | null>(null)
    const [openDetail, setOpenDetail] = useState<OpenDetail | null>(null)
    const detailTrigger = useRef<{ scope: BrowserScope; element: HTMLElement } | null>(null)

    // Kept out of loadTables' deps: callers pass this callback inline, and a fresh identity on every
    // render would make the effect below refetch forever.
    const consumeRequestedRef = useRef(onInitialConsumed)
    useEffect(() => {
        consumeRequestedRef.current = onInitialConsumed
    })

    const loadTables = useCallback(() => {
        const request = ++tableRead.current
        const current = () => mounted.current && tableRead.current === request && scopeRef.current.source === source
        setLoadingTables(true)
        setError(null)
        return source
            .listTables()
            .then(result => {
                if (!current()) return
                setTables(result)
                // Consumed here rather than in a setState updater: React double-invokes updaters in
                // development, and this fires a toast and a callback.
                const requestedTable = requestedTableRef.current
                if (requestedTable) {
                    requestedTableRef.current = null
                    consumeRequestedRef.current?.()
                    if (result.some(t => t.name === requestedTable)) {
                        setSelected(requestedTable)
                        return
                    }
                    if (requireInitialView) {
                        setSelected(null)
                        setInitialTargetError(`The table “${requestedTable}” is no longer available. Open Database to choose another table.`)
                        return
                    }
                    toast.error('Table not found', { description: requestedTable })
                }
                setSelected(prev => pinnedTable ?? (prev && result.some(t => t.name === prev) ? prev : (result[0]?.name ?? null)))
            })
            .catch((e: unknown) => { if (current()) setError(e instanceof Error && e.message ? e.message : source.unreachableMessage) })
            .finally(() => { if (current()) setLoadingTables(false) })
    }, [source, pinnedTable, requireInitialView])
    const reloadTablesRef = useRef(loadTables)
    reloadTablesRef.current = loadTables

    useEffect(() => {
        loadTables()
    }, [loadTables])

    useEffect(() => {
        const id = setTimeout(() => setQuery(search.trim()), 300)
        return () => clearTimeout(id)
    }, [search])

    useEffect(() => {
        setPageIndex(0)
        setSearch('')
        setQuery('')
        setSelectedRowIds(new Set())
        setActionError(null)
        setPreferenceError(null)
        setBusy(false)
        setAddingView(false)
        setData(null)
        setKindSample(null)
        setOpenDetail(null)
        setViewDialog(current => ({ open: false, generation: current.generation + 1 }))
    }, [source, selected])

    useEffect(() => {
        if (!selected) return
        let cancelled = false
        const selection = viewSelection.current
        setActiveId(null)
        const preferenceRequest = source.preferredView
            ? source.preferredView.read(selected).then(viewId => ({ viewId, error: null as string | null }), () => ({ viewId: null, error: 'Could not restore your preferred view. Choose a view to try saving it again.' }))
            : Promise.resolve({ viewId: readLastView(source.storageKey, selected), error: null as string | null })
        source.listViews(selected).then(async result => {
            if (cancelled || !currentScope()) return
            const list = result.success ? result.views : []
            setViews(list)
            setViewsError(result.success ? null : result.error)
            const preference = await preferenceRequest
            if (cancelled || !currentScope() || viewSelection.current !== selection) return
            setPreferenceError(preference.error)
            const wanted = requestedViewRef.current
            requestedViewRef.current = undefined
            const requestedView = requireInitialView ? list.find(view => view.id === wanted) : findView(list, wanted)
            if (requireInitialView && wanted && !requestedView) {
                setInitialTargetError(result.success
                    ? 'This saved view is no longer available. Open Database to choose another view.'
                    : result.error)
                return
            }
            const remembered = preference.viewId
            const picked = requestedView ?? (remembered && remembered !== ALL_ROWS ? findView(list, remembered) : undefined)
            setActiveId(picked?.id ?? (remembered === ALL_ROWS ? ALL_ROWS : (list[0]?.id ?? ALL_ROWS)))
        })
        return () => {
            cancelled = true
        }
    }, [source, selected, viewsRefreshKey, requireInitialView])

    const activeView = activeId && activeId !== ALL_ROWS ? views.find(view => view.id === activeId) : undefined
    const boardView = activeView?.layout === 'board' && activeView.groupBy ? (activeView as TableView & { groupBy: string }) : undefined

    // A view brings its own order; a click on a header overrides it until the view changes.
    useEffect(() => {
        setPageIndex(0)
        setSelectedRowIds(new Set())
        setSorting(activeView?.sort ? [{ id: activeView.sort.column, desc: activeView.sort.dir === 'desc' }] : [])
        // A switch of view, or a save that changes its sort, resets the order; a save that keeps it does not.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [activeId, activeView?.sort?.column, activeView?.sort?.dir])

    useEffect(() => {
        if (!selected || activeId === null) {
            setData(null)
            return
        }
        let cancelled = false
        const sort = sorting[0]
        setLoadingRows(true)
        source
            .readRows(selected, {
                limit: pageSize,
                offset: pageIndex * pageSize,
                sort: sort?.id,
                dir: sort ? (sort.desc ? 'desc' : 'asc') : undefined,
                q: query || undefined,
                where: activeView?.where,
            })
            .then(result => {
                if (cancelled) return
                setData(result)
                setLoadingRows(false)
                const sampleKey = `${selected}\u0000${activeId}`
                if (result) setKindSample(current => (current?.key === sampleKey ? current : { key: sampleKey, rows: result.rows as DbRow[] }))
            })
        return () => {
            cancelled = true
        }
    }, [source, selected, activeId, activeView?.where, pageIndex, pageSize, sorting, query, refreshKey, rowsRefreshKey])

    const onBoardRowsChanged = useCallback(() => {
        // A successful move must refresh the parent's view-settings sample as well as the
        // board's lanes. Keep this separate from refreshKey to avoid a second board reload.
        if (sameOwner()) setRowsRefreshKey(key => key + 1)
    }, [source, selected])

    const tableMeta = tables.find(t => t.name === selected)
    const allColumns = useMemo(() => tableMeta?.columns.map(c => c.name) ?? [], [tableMeta])
    const sampleRows = kindSample?.key === `${selected}\u0000${activeId}` ? kindSample.rows : undefined
    const friendly = useMemo(() => friendlyColumns(tableMeta?.columns ?? [], sampleRows ?? []), [tableMeta, sampleRows])
    const friendlyByKey = useMemo(() => new Map(friendly.map(column => [column.key, column])), [friendly])
    const viewOrder = activeView?.layout === 'table' && activeView.columns?.length ? activeView.columns : undefined
    const sheetColumns = useMemo(() => gridColumns(friendly, viewOrder), [friendly, viewOrder])
    const visibleDetail = openDetail && openDetail.source === source && openDetail.table === selected && rowKey(openDetail.row) === openDetail.key ? openDetail : null
    const openRow = (row: DbRow, element: HTMLElement) => {
        const current = scopeRef.current
        if (!current.table || current.source !== source || current.table !== selected) return
        detailTrigger.current = { scope: current, element }
        setOpenDetail({ source: current.source, table: current.table, key: rowKey(row), row })
    }
    const returned = data?.columns
    const shownColumns = useMemo(() => {
        if (viewOrder) return viewOrder
        const ordered = gridColumns(friendly).map(column => column.key)
        // A column the engine returns but the schema we hold does not know yet still shows.
        return returned ? [...ordered.filter(key => returned.includes(key)), ...returned.filter(key => !friendlyByKey.has(key))] : ordered
    }, [viewOrder, friendly, friendlyByKey, returned])

    const columns = useMemo<ColumnDef<DbRow>[]>(
        () =>
            shownColumns.map(col => ({
                id: col,
                accessorKey: col,
                header: col,
            })),
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [shownColumns.join('\u0000')],
    )

    const total = data?.total ?? 0
    const rows = useMemo(() => (data?.rows ?? []) as DbRow[], [data?.rows])
    const canSelectRows = rows.length > 0 && rowKey(rows[0]) !== null

    const pageKeys = useMemo(() => rows.map(rowKey).filter((k): k is string => k !== null), [rows])
    const allPageSelected = pageKeys.length > 0 && pageKeys.every(k => selectedRowIds.has(k))

    const cellContext: CellContext = { tones: activeView?.tones, fileUrl: source.fileUrl }

    const table = useReactTable({
        data: rows,
        columns,
        getRowId: (row, index) => rowKey(row) ?? String(index),
        state: { sorting, pagination: { pageIndex, pageSize } },
        manualSorting: true,
        manualFiltering: true,
        manualPagination: true,
        rowCount: total,
        onSortingChange: setSorting,
        onPaginationChange: updater => {
            const next = typeof updater === 'function' ? updater({ pageIndex, pageSize }) : updater
            setPageIndex(next.pageIndex)
            setPageSize(next.pageSize)
        },
        getCoreRowModel: getCoreRowModel(),
    })

    const toggleRow = useCallback((key: string) => {
        setSelectedRowIds(prev => {
            const next = new Set(prev)
            if (next.has(key)) next.delete(key)
            else next.add(key)
            return next
        })
    }, [])

    const toggleAllPage = useCallback(() => {
        setSelectedRowIds(prev => {
            const next = new Set(prev)
            const everySelected = pageKeys.length > 0 && pageKeys.every(k => next.has(k))
            if (everySelected) pageKeys.forEach(k => next.delete(k))
            else pageKeys.forEach(k => next.add(k))
            return next
        })
    }, [pageKeys])

    const deleteRows = useCallback(
        async (ids: (number | string)[]) => {
            if (!selected || ids.length === 0) return
            setBusy(true)
            setActionError(null)
            const result = await source.deleteRows(selected, ids)
            if (!currentScope()) {
                if (result.success && sameOwner()) setRefreshKey(k => k + 1)
                return
            }
            setBusy(false)
            if (!result.success) {
                setActionError(result.error ?? 'Failed to delete rows')
                return
            }
            setSelectedRowIds(new Set())
            setPageIndex(0)
            setRefreshKey(k => k + 1)
        },
        [source, selected, scope],
    )

    const saveRow = useCallback(
        async (row: DbRow, values: Record<string, SqlValue>): Promise<DbRow | null> => {
            const id = rowKey(row)
            if (!selected || id === null) return null
            const result = await source.updateRow(selected, id, values)
            if (!result.success) {
                if (currentScope()) toast.error('Could not save this row', { description: result.error })
                return null
            }
            if (currentScope()) setData(current => current && { ...current, rows: current.rows.map(r => (rowKey(r as DbRow) === id ? result.row : r)) })
            // A -> B -> A can reload A before its old save finishes. Re-read that owner
            // instead of either losing its successful mutation or patching another table.
            else if (sameOwner()) setRefreshKey(k => k + 1)
            return result.row as DbRow
        },
        [source, selected, scope],
    )

    const editCell = useCallback(
        async (row: DbRow, column: string, text: string) => (await saveRow(row, { [column]: coerceCellInput(text, tableMeta?.columns.find(c => c.name === column)) })) !== null,
        [saveRow, tableMeta],
    )

    const confirmDropTable = useCallback(async () => {
        setTableDialogOpen(false)
        if (!selected) return
        setBusy(true)
        setActionError(null)
        const result = await source.dropTable(selected)
        if (!currentScope()) {
            // The drop is already durable. Refresh only its database, using the current
            // pinned-table choice; never invoke an old parent's close/drop callback.
            if (result.success && mounted.current && scopeRef.current.source === source) await reloadTablesRef.current()
            return
        }
        setBusy(false)
        if (!result.success) {
            setActionError(result.error ?? 'Failed to delete table')
            return
        }
        if (onTableDropped) onTableDropped()
        else await loadTables()
    }, [source, selected, scope, loadTables, onTableDropped])

    const confirmPurgeTable = useCallback(async () => {
        setPurgeDialogOpen(false)
        if (!selected) return
        setBusy(true)
        setActionError(null)
        const result = await source.purgeTable(selected)
        if (!currentScope()) {
            if (result.success && sameOwner()) setRefreshKey(k => k + 1)
            return
        }
        setBusy(false)
        if (!result.success) {
            setActionError(result.error ?? 'Failed to purge table')
            return
        }
        setSelectedRowIds(new Set())
        setPageIndex(0)
        setRefreshKey(k => k + 1)
    }, [source, selected, scope])

    const exportTable = useCallback(
        async (format: 'csv' | 'json') => {
            if (!selected) return
            const sort = sorting[0]
            const params = {
                    format,
                    sort: sort?.id,
                    dir: sort ? (sort.desc ? 'desc' : 'asc') : undefined,
                    q: query || undefined,
                    where: activeView?.where,
                } as const
            if (!source.exportFile) { window.open(source.exportUrl(selected, params), '_blank'); return }
            exportRequest.current?.abort()
            const controller = new AbortController()
            exportRequest.current = controller
            setActionError(null)
            try { await source.exportFile(selected, params, controller.signal) }
            catch (error) {
                if (exportRequest.current === controller && !controller.signal.aborted)
                    setActionError(error instanceof Error ? error.message : 'Could not export this table.')
            } finally { if (exportRequest.current === controller) exportRequest.current = null }
        },
        [source, selected, sorting, query, activeView?.where],
    )

    const selectView = (id: string) => {
        if (!currentScope()) return
        const selection = ++viewSelection.current
        setPreferenceError(null)
        if (selected) {
            if (source.preferredView) {
                void source.preferredView.write(selected, id).catch(() => {
                    if (currentScope() && viewSelection.current === selection) setPreferenceError('Could not remember this view. Your current view is still open; select it again to retry.')
                })
            } else writeLastView(source.storageKey, selected, id)
        }
        setActiveId(id)
    }

    const onViewSaved = (view: TableView, select = true) => {
        if (!currentScope()) {
            if (sameOwner()) setViewsRefreshKey(k => k + 1)
            return
        }
        setViews(current => (current.some(v => v.id === view.id) ? current.map(v => (v.id === view.id ? view : v)) : [...current, view]))
        if (select) selectView(view.id)
        setRefreshKey(k => k + 1)
    }

    const addView = async (layout: CardLayout) => {
        if (!selected) return
        const input = quickViewInput(layout, { columns: allColumns, rows, takenNames: views.map(view => view.name) })
        if (!input) {
            setViewDialog(current => ({ open: true, layout, generation: current.generation + 1 }))
            return
        }
        setAddingView(true)
        const result = await source.saveView(selected, input)
        if (currentScope()) setAddingView(false)
        if (!result.success) {
            if (currentScope()) toast.error('Could not add this view', { description: result.error })
            return
        }
        onViewSaved(result.view)
    }

    const deleteView = async (view: TableView) => {
        if (!selected) return
        const result = await source.deleteView(selected, view.id)
        if (!result.success) {
            if (currentScope()) toast.error('Could not delete this view', { description: result.error })
            return
        }
        if (!currentScope()) {
            if (sameOwner()) setViewsRefreshKey(k => k + 1)
            return
        }
        setViews(current => current.filter(v => v.id !== view.id))
        if (activeIdRef.current === view.id) selectView(ALL_ROWS)
    }

    if (loadingTables) return <DataBrowserSkeleton />

    if (error) {
        return <EmptyState className="h-full" icon={DatabaseIcon} title="Database unavailable" description={error} />
    }

    if (initialTargetError) {
        return <EmptyState className="h-full" icon={DatabaseIcon} title="Saved view unavailable" description={initialTargetError} />
    }

    if (tables.length === 0) {
        return <EmptyState className="h-full" icon={DatabaseIcon} title={source.emptyTitle} description={source.emptyDescription} />
    }

    return (
        <div className="@container flex h-full min-h-0 flex-col">
            <div className="shrink-0 px-4 pt-5 @3xl:px-12 @3xl:pt-10">
                <span className="hidden size-10 items-center justify-center rounded-lg bg-muted text-muted-foreground @3xl:mb-3 @3xl:inline-flex">
                    <TableIcon className="size-5" />
                </span>
                <div className="flex min-w-0 items-center">
                    {pinnedTable || tables.length < 2 ? (
                        <h1 className="min-w-0 truncate text-xl font-semibold tracking-tight text-foreground @3xl:text-3xl">{humanizeTableName(selected ?? '')}</h1>
                    ) : (
                        <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                                <Button variant="ghost" className="-ml-2 h-auto min-w-0 gap-1.5 px-2 py-0.5 text-xl font-semibold tracking-tight text-foreground @3xl:text-3xl">
                                    <span className="truncate">{humanizeTableName(selected ?? '')}</span>
                                    <ChevronDownIcon className="size-4 shrink-0 text-muted-foreground" />
                                </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="start" className="max-h-80 min-w-56 overflow-y-auto">
                                {tables.map(t => (
                                    <DropdownMenuItem key={t.name} onSelect={() => setSelected(t.name)}>
                                        <TableIcon />
                                        <span className="min-w-0 flex-1 truncate">{humanizeTableName(t.name)}</span>
                                        {selected === t.name && <CheckIcon />}
                                    </DropdownMenuItem>
                                ))}
                            </DropdownMenuContent>
                        </DropdownMenu>
                    )}
                </div>
                <p className="mt-1 text-xs text-muted-foreground">{data ? `${total.toLocaleString('en-US')} ${total === 1 ? 'row' : 'rows'}${query ? ' found' : ''}` : '\u00a0'}</p>
                {activeId !== null && (
                    <div className="mt-4">
                        <DataViewBar
                            key={scopeSequence.current}
                            views={views}
                            activeId={activeId}
                            unavailableReason={viewsError ?? undefined}
                            onSelect={selectView}
                            onAdd={addView}
                            adding={addingView}
                            onEdit={view => setViewDialog(current => ({ open: true, view, generation: current.generation + 1 }))}
                            onDelete={deleteView}
                            onExpand={onExpand && selected ? () => onExpand({ table: selected, view: activeId === ALL_ROWS ? undefined : activeId }) : undefined}
                            actions={
                                <DataBrowserToolbar
                                    search={search}
                                    selectedCount={selectedRowIds.size}
                                    busy={busy}
                                    onSearchChange={value => {
                                        setSearch(value)
                                        setPageIndex(0)
                                    }}
                                    onClearSelection={() => setSelectedRowIds(new Set())}
                                    onDeleteSelected={() => deleteRows(Array.from(selectedRowIds))}
                                    onExport={exportTable}
                                    onPurgeTable={() => setPurgeDialogOpen(true)}
                                    onDropTable={() => setTableDialogOpen(true)}
                                />
                            }
                        />
                    </div>
                )}
            </div>
            {actionError && <div className="mx-4 mt-2 rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive @3xl:mx-12">{actionError}</div>}
            {preferenceError && <div role="alert" className="mx-4 mt-2 rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive @3xl:mx-12">{preferenceError}</div>}
            <div className={cn('min-h-0 flex-1 overflow-auto', !boardView && '@3xl:px-12')}>
                {boardView && selected ? (
                    <ViewBoard source={source} table={selected} view={boardView} query={query} refreshKey={refreshKey} context={cellContext} onRowsChanged={onBoardRowsChanged} onOpenRow={openRow} />
                ) : (loadingRows && !data) || activeId === null ? (
                    <SkeletonGrid />
                ) : rows.length === 0 ? (
                    <EmptyState className="h-full" icon={DatabaseIcon} title="No rows" description={search ? 'No row matches this search.' : 'This table is empty.'} />
                ) : activeView?.layout === 'list' ? (
                    <ViewList view={activeView} rows={rows} context={cellContext} onOpenRow={openRow} />
                ) : activeView?.layout === 'gallery' ? (
                    <ViewGallery view={activeView} rows={rows} context={cellContext} onOpenRow={openRow} />
                ) : (
                    <DataBrowserTable
                        key={scopeSequence.current}
                        table={table}
                        friendly={friendlyByKey}
                        canSelectRows={canSelectRows}
                        allPageSelected={allPageSelected}
                        selectedRowIds={selectedRowIds}
                        onToggleRow={toggleRow}
                        onToggleAllPage={toggleAllPage}
                        formats={activeView?.formats}
                        cellContext={cellContext}
                        onEditCell={editCell}
                    />
                )}
            </div>
            {!boardView && (
                <DataBrowserPagination
                    pageIndex={pageIndex}
                    pageSize={pageSize}
                    shown={rows.length}
                    total={total}
                    onPageSizeChange={size => {
                        setPageSize(size)
                        setPageIndex(0)
                    }}
                    onPageChange={setPageIndex}
                />
            )}
            {selected && (
                <ViewSettingsDialog
                    key={`${scopeSequence.current}:${viewDialog.generation}`}
                    open={viewDialog.open}
                    onOpenChange={open => {
                        if (!currentScope()) return
                        setViewDialog(current => current.generation === viewDialog.generation
                            ? { ...current, open, generation: current.generation + 1 } : current)
                    }}
                    source={source}
                    table={selected}
                    columns={allColumns}
                    sample={{ rows, total }}
                    view={viewDialog.view}
                    initialLayout={viewDialog.layout}
                    onSaved={view => onViewSaved(view, dialogRef.current.generation === viewDialog.generation)}
                />
            )}
            <LeadSourcesSheet
                row={visibleDetail?.row ?? null}
                onOpenChange={open => {
                    if (open || !visibleDetail) return
                    setOpenDetail(current => current && current.source === visibleDetail.source && current.table === visibleDetail.table && current.key === visibleDetail.key ? null : current)
                }}
                onCloseAutoFocus={event => {
                    if (visibleDetail) return
                    const trigger = detailTrigger.current
                    detailTrigger.current = null
                    if (!trigger || !mounted.current || trigger.scope !== scopeRef.current || !trigger.element.isConnected) return
                    event.preventDefault()
                    trigger.element.focus({ preventScroll: true })
                }}
                columns={sheetColumns}
                sources={null}
                tones={activeView?.tones}
            />
            <PurgeTableDialog open={purgeDialogOpen} onOpenChange={setPurgeDialogOpen} onConfirm={confirmPurgeTable} table={selected ?? ''} />
            <DeleteTableDialog open={tableDialogOpen} onOpenChange={setTableDialogOpen} onConfirm={confirmDropTable} table={selected ?? ''} />
        </div>
    )
}

function SkeletonGrid() {
    return (
        <div className="px-4 @3xl:px-0">
            <SkeletonTable rows={10} cols={5} className="[&>div]:h-9 [&>div]:items-center" />
        </div>
    )
}

function DataBrowserSkeleton() {
    return (
        <div className="@container flex h-full flex-col">
            <div className="px-4 pt-5 @3xl:px-12 @3xl:pt-10">
                <Skeleton className="mb-3 hidden size-10 rounded-lg @3xl:block" />
                <Skeleton className="h-6 w-48 @3xl:h-8" />
                <Skeleton className="mt-2 h-3 w-16" />
                <div className="mt-4 flex gap-4 border-b border-border pb-2.5">
                    <Skeleton className="h-4 w-16" />
                    <Skeleton className="h-4 w-20" />
                </div>
            </div>
            <div className="@3xl:px-12">
                <SkeletonGrid />
            </div>
        </div>
    )
}

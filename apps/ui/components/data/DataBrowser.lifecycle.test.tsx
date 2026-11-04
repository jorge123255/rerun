// @vitest-environment happy-dom
import { act, useState, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { Table } from '@tanstack/react-table'
import type { TableView } from '@rerun/contracts'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DataSource } from '@/lib/data/source'
import type { DbRow } from './DataBrowserTable'
import type { DragEndEvent } from '@dnd-kit/core'

const boardDrag = vi.hoisted(() => ({ end: null as null | ((event: DragEndEvent) => void) }))
vi.mock('@dnd-kit/core', () => ({
    DndContext: ({ children, onDragEnd }: { children: ReactNode; onDragEnd: (event: DragEndEvent) => void }) => { boardDrag.end = onDragEnd; return <>{children}</> },
    DragOverlay: ({ children }: { children: ReactNode }) => <>{children}</>,
    KeyboardSensor: class {}, PointerSensor: class {}, useSensor: () => ({}), useSensors: () => [],
    useDroppable: () => ({ setNodeRef: () => {}, isOver: false }),
    useDraggable: () => ({ setNodeRef: () => {}, listeners: {}, attributes: {}, isDragging: false }),
}))
vi.mock('@rerun/ui/chat', async importOriginal => ({
    ...await importOriginal<typeof import('@rerun/ui/chat')>(),
    BoardColumnHeader: ({ value, total }: { value: string; total: number }) => <h2>{value}: {total}</h2>,
    BoardItem: ({ row }: { row: DbRow }) => <span>{String(row.body)}</span>,
}))

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const mounts = new Map<Root, HTMLDivElement>()
async function render(node: ReactNode) {
    const container = document.createElement('div'); document.body.append(container)
    const root = createRoot(container); mounts.set(root, container)
    await act(async () => root.render(node))
    return {
        rerender: (next: ReactNode) => act(async () => root.render(next)),
        unmount: async () => { await act(async () => root.unmount()); container.remove(); mounts.delete(root) },
    }
}
async function cleanup() {
    for (const [root, container] of mounts) { await act(async () => root.unmount()); container.remove() }
    mounts.clear()
}
async function click(node: HTMLElement) { await act(async () => node.click()) }
async function waitFor<T>(read: () => T): Promise<T> {
    let error: unknown
    for (let attempt = 0; attempt < 100; attempt++) {
        try { return read() } catch (caught) { error = caught }
        await act(async () => { await new Promise(resolve => setTimeout(resolve, 5)) })
    }
    throw error
}
const textOf = (node: Element) => node.textContent?.trim()
const queryByText = (value: string) => [...document.querySelectorAll<HTMLElement>('body *')].find(node => textOf(node) === value && ![...node.children].some(child => textOf(child) === value)) ?? null
const screen = {
    queryByText,
    getByText: (value: string) => { const node = queryByText(value); expect(node, value).not.toBeNull(); return node! },
    findByText: (value: string) => waitFor(() => screen.getByText(value)),
    getByLabelText: (value: string) => { const node = [...document.querySelectorAll<HTMLElement>('[aria-label]')].find(node => node.getAttribute('aria-label') === value); expect(node, value).toBeDefined(); return node! },
    getByRole: (role: string, { name }: { name: string }) => {
        const nodes = role === 'button' ? document.querySelectorAll<HTMLElement>('button') : document.querySelectorAll<HTMLElement>('[role]')
        const node = [...nodes].find(node => (role === 'button' || node.getAttribute('role') === role) && (node.getAttribute('aria-label') ?? textOf(node)) === name)
        expect(node, `${role}: ${name}`).toBeDefined(); return node!
    },
}

// Keep the actual browser and React Table state; only remove unrelated popover/layout shells.
vi.mock('@/components/ui/dropdown-menu', () => ({
    DropdownMenu: ({ children }: { children: ReactNode }) => <div>{children}</div>,
    DropdownMenuTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
    DropdownMenuContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
    DropdownMenuItem: ({ children, onSelect }: { children: ReactNode; onSelect: () => void }) => <button onClick={onSelect}>{children}</button>,
}))
vi.mock('@/components/dialogs/DeleteTableDialog', () => ({ DeleteTableDialog: ({ open, onConfirm }: { open: boolean; onConfirm: () => void }) => open ? <button onClick={onConfirm}>Confirm drop</button> : null }))
vi.mock('@/components/dialogs/PurgeTableDialog', () => ({ PurgeTableDialog: ({ open, onConfirm }: { open: boolean; onConfirm: () => void }) => open ? <button onClick={onConfirm}>Confirm purge</button> : null }))
vi.mock('@/components/data/DataBrowserToolbar', () => ({ DataBrowserToolbar: ({ onPurgeTable, onDropTable, onDeleteSelected, busy }: { onPurgeTable: () => void; onDropTable: () => void; onDeleteSelected: () => void; busy: boolean }) => <>
    <button disabled={busy} onClick={onPurgeTable}>Purge table</button><button disabled={busy} onClick={onDropTable}>Drop table</button>
    <button disabled={busy} onClick={onDeleteSelected}>Delete selected</button>
</> }))
vi.mock('@/components/data/DataBrowserPagination', () => ({ DataBrowserPagination: () => null }))
vi.mock('@/components/data/DataBrowserTable', () => ({
    rowKey: (row: DbRow) => row.__rowid == null ? null : String(row.__rowid),
    DataBrowserTable: ({ table, onEditCell, onToggleRow }: { table: Table<DbRow>; onEditCell: (row: DbRow, column: string, value: string) => Promise<boolean>; onToggleRow: (id: string) => void }) => <div>
        {table.getRowModel().rows.map(row => <div key={row.id}>
            <span>{String(row.original.body)}</span>
            <button onClick={() => void onEditCell(row.original, 'body', 'Saved alpha')}>Save row</button>
            <button onClick={() => onToggleRow(String(row.original.__rowid))}>Select row</button>
        </div>)}
    </div>,
}))
type BarProps = { views: TableView[]; activeId: string; adding: boolean; actions?: ReactNode; onAdd: (layout: 'table') => void; onSelect: (id: string) => void; onEdit: (view: TableView) => void; onDelete: (view: TableView) => void }
vi.mock('@/components/data/DataViewBar', () => ({ DataViewBar: ({ views, activeId, adding, actions, onAdd, onSelect, onEdit, onDelete }: BarProps) => <div>
    <output aria-label="Active view">{activeId}</output>
    <button disabled={adding} onClick={() => onAdd('table')}>Add table view</button>
    <button onClick={() => onSelect('__all')}>All rows</button>
    {views.map(view => <div key={view.id}>
        <span>{view.name}</span>
        <button onClick={() => onEdit(view)}>Edit {view.name}</button>
        <button onClick={() => onDelete(view)}>Delete {view.name}</button>
    </div>)}
    {actions}
</div> }))
type SettingsProps = { open: boolean; source: DataSource; table: string; view?: TableView; sample: { rows: DbRow[] }; onSaved: (view: TableView) => void; onOpenChange: (open: boolean) => void }
vi.mock('@/components/dialogs/ViewSettingsDialog', () => ({ ViewSettingsDialog: function Settings({ open, source, table, view, sample, onSaved, onOpenChange }: SettingsProps) {
    const [error, setError] = useState('')
    return open ? <div role="dialog" aria-label="View settings">
    <span>Editing {view?.name}</span>
    {view?.layout === 'board' && <output aria-label="Preview statuses">{JSON.stringify(sample.rows.map(row => row.status))}</output>}
    {error && <p role="alert">{error}</p>}
    <button onClick={() => void source.saveView(table, { name: 'Saved settings', layout: 'table' }, view?.id).then(result => {
        if (result.success) { onSaved(result.view); onOpenChange(false) }
        else setError(result.error)
    })}>Save settings</button>
    <button onClick={() => onOpenChange(false)}>Cancel settings</button>
</div> : null } }))

import { DataBrowser } from './DataBrowser'

function deferred<T>() {
    let resolve!: (value: T) => void
    const promise = new Promise<T>(done => { resolve = done })
    return { promise, resolve }
}
const view = (table: string, name = `${table} view`): TableView => ({ id: `${table}-view`, table, name, layout: 'table', columns: ['body'], position: 0 })
function fixture(owner = 'Owner') {
    const rows: Record<string, DbRow> = { alpha: { __rowid: 1, body: `${owner} alpha` }, beta: { __rowid: 1, body: `${owner} beta` } }
    const views: Record<string, TableView[]> = { alpha: [view('alpha')], beta: [view('beta')] }
    const source: DataSource = {
        scope: 'agent', storageKey: owner,
        listTables: vi.fn<DataSource['listTables']>(async () => ['alpha', 'beta'].map(name => ({ name, columns: [{ name: 'body', type: 'TEXT', pk: false, notnull: false }] }))),
        readRows: vi.fn<DataSource['readRows']>(async table => ({ columns: ['body'], rows: [{ ...rows[table] }], total: 1 })),
        listViews: vi.fn<DataSource['listViews']>(async table => ({ success: true, views: [...views[table]!] })),
        updateRow: vi.fn<DataSource['updateRow']>(async (table, _id, values) => ({ success: true, row: rows[table] = { ...rows[table], ...values } })),
        saveView: vi.fn<DataSource['saveView']>(async (table, input, id) => ({ success: true, view: { ...view(table, input.name), id: id ?? `${table}-new` } })),
        deleteView: vi.fn<DataSource['deleteView']>(async () => ({ success: true })),
        deleteRows: vi.fn<DataSource['deleteRows']>(async () => ({ success: true })), dropTable: vi.fn<DataSource['dropTable']>(async () => ({ success: true })), purgeTable: vi.fn<DataSource['purgeTable']>(async () => ({ success: true })),
        readGroups: vi.fn<DataSource['readGroups']>(async () => ({ success: true, groups: [] })), exportUrl: () => '/unused',
        unreachableMessage: 'Unavailable', emptyTitle: 'Empty', emptyDescription: 'Empty',
    }
    return { source, rows, views }
}
const switchTable = async (name: 'Alpha' | 'Beta', body: string) => {
    await click(screen.getByRole('button', { name }))
    await screen.findByText(body)
}

beforeEach(() => {
    boardDrag.end = null
    const stored = new Map<string, string>()
    Object.defineProperty(window, 'localStorage', { configurable: true, value: { getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => stored.set(key, value) } })
})
afterEach(async () => { await cleanup(); vi.clearAllMocks() })

describe('DataBrowser mutation ownership', () => {
    it('refreshes the parent settings preview after a real board move without another board reload loop', async () => {
        const f = fixture()
        f.rows.alpha = { ...f.rows.alpha, status: 'Todo' }
        f.views.alpha = [{ ...view('alpha'), layout: 'board', groupBy: 'status', fields: { title: 'body' } }]
        vi.mocked(f.source.readGroups).mockImplementation(async () => ({ success: true, groups: ['Todo', 'Done'].map(value => ({ value, total: f.rows.alpha!.status === value ? 1 : 0 })) }))
        vi.mocked(f.source.readRows).mockImplementation(async (table, params) => ({ columns: ['body', 'status'], rows: !params.where?.length || params.where.at(-1)?.equals === f.rows[table]!.status ? [{ ...f.rows[table] }] : [], total: 1 }))
        await render(<DataBrowser source={f.source} />)
        await click(screen.getByRole('button', { name: 'Edit alpha view' }))
        expect(screen.getByLabelText('Preview statuses').textContent).toBe('["Todo"]')
        await click(screen.getByRole('button', { name: 'Cancel settings' }))
        const groupsBefore = vi.mocked(f.source.readGroups).mock.calls.length
        const rowsBefore = vi.mocked(f.source.readRows).mock.calls.filter(([, params]) => !params.where?.length).length
        expect(boardDrag.end).not.toBeNull()
        await act(async () => { boardDrag.end!({ active: { data: { current: { row: { ...f.rows.alpha }, from: '"Todo"' } } }, over: { id: '"Done"' } } as unknown as DragEndEvent) })
        expect(f.rows.alpha!.status).toBe('Done')
        await click(screen.getByRole('button', { name: 'Edit alpha view' }))
        expect(screen.getByLabelText('Preview statuses').textContent).toBe('["Done"]')
        expect(vi.mocked(f.source.readGroups).mock.calls.length).toBe(groupsBefore + 1)
        expect(vi.mocked(f.source.readRows).mock.calls.filter(([, params]) => !params.where?.length).length).toBe(rowsBefore + 1)
    })

    it('does not refresh another database when an old board move finishes after that board unmounts', async () => {
        const a = fixture('First'), b = fixture('Second'), pending = deferred<Awaited<ReturnType<DataSource['updateRow']>>>()
        a.rows.alpha = { ...a.rows.alpha, status: 'Todo' }
        a.views.alpha = [{ ...view('alpha'), layout: 'board', groupBy: 'status', fields: { title: 'body' } }]
        vi.mocked(a.source.readGroups).mockResolvedValue({ success: true, groups: [{ value: 'Todo', total: 1 }, { value: 'Done', total: 0 }] })
        vi.mocked(a.source.updateRow).mockImplementation(() => pending.promise)
        const mounted = await render(<DataBrowser source={a.source} />)
        await act(async () => { boardDrag.end!({ active: { data: { current: { row: { ...a.rows.alpha }, from: '"Todo"' } } }, over: { id: '"Done"' } } as unknown as DragEndEvent) })
        await mounted.rerender(<DataBrowser source={b.source} />)
        await screen.findByText('Second alpha')
        const currentReads = vi.mocked(b.source.readRows).mock.calls.length
        await act(async () => { pending.resolve({ success: true, row: { ...a.rows.alpha, status: 'Done' } }) })
        expect(vi.mocked(b.source.readRows).mock.calls.length).toBe(currentReads)
        expect(screen.getByText('Second alpha')).toBeTruthy()
    })

    it('does not apply a delayed alpha row to beta with the same rowid, and reads the successful save on return', async () => {
        const f = fixture(), pending = deferred<Awaited<ReturnType<DataSource['updateRow']>>>()
        vi.mocked(f.source.updateRow).mockImplementation(() => pending.promise)
        await render(<DataBrowser source={f.source} />)
        await screen.findByText('Owner alpha')
        await click(screen.getByRole('button', { name: 'Save row' }))
        await switchTable('Beta', 'Owner beta')
        await act(async () => { f.rows.alpha = { __rowid: 1, body: 'Saved alpha' }; pending.resolve({ success: true, row: f.rows.alpha }) })
        expect(screen.getByText('Owner beta')).toBeTruthy()
        expect(screen.queryByText('Saved alpha')).toBeNull()
        await switchTable('Alpha', 'Saved alpha')
        expect(f.source.updateRow).toHaveBeenCalledWith('alpha', '1', { body: 'Saved alpha' })
    })

    it('refreshes alpha if it was revisited before the earlier save completed', async () => {
        const f = fixture(), pending = deferred<Awaited<ReturnType<DataSource['updateRow']>>>()
        vi.mocked(f.source.updateRow).mockImplementation(() => pending.promise)
        await render(<DataBrowser source={f.source} />)
        await screen.findByText('Owner alpha')
        await click(screen.getByRole('button', { name: 'Save row' }))
        await switchTable('Beta', 'Owner beta')
        await switchTable('Alpha', 'Owner alpha')
        await act(async () => { f.rows.alpha = { __rowid: 1, body: 'Saved alpha' }; pending.resolve({ success: true, row: f.rows.alpha }) })
        await screen.findByText('Saved alpha')
        expect(f.source.updateRow).toHaveBeenCalledTimes(1)
    })

    it('does not publish old-source rows or a late table listing after a database change', async () => {
        const a = fixture('First'), b = fixture('Second'), pending = deferred<Awaited<ReturnType<DataSource['updateRow']>>>()
        vi.mocked(a.source.updateRow).mockImplementation(() => pending.promise)
        const mounted = await render(<DataBrowser source={a.source} />)
        await screen.findByText('First alpha')
        await click(screen.getByRole('button', { name: 'Save row' }))
        await mounted.rerender(<DataBrowser source={b.source} />)
        await screen.findByText('Second alpha')
        await act(async () => { pending.resolve({ success: true, row: { __rowid: 1, body: 'First late' } }) })
        expect(screen.getByText('Second alpha')).toBeTruthy()
        expect(screen.queryByText('First late')).toBeNull()
        await mounted.unmount()
        const listing = deferred<Awaited<ReturnType<DataSource['listTables']>>>()
        vi.mocked(a.source.listTables).mockImplementation(() => listing.promise)
        const next = await render(<DataBrowser source={a.source} />)
        await next.rerender(<DataBrowser source={b.source} />)
        await screen.findByText('Second alpha')
        await act(async () => { listing.resolve([{ name: 'obsolete', columns: [] }]) })
        expect(screen.getByText('Second alpha')).toBeTruthy()
        expect(screen.queryByText('Obsolete')).toBeNull()
    })

    it.each(['add', 'delete'] as const)('keeps a delayed %s view result with its table, including a revisit before completion', async action => {
        const f = fixture()
        const added = { ...view('alpha', 'Alpha saved'), id: 'alpha-added' }
        const saving = deferred<Awaited<ReturnType<DataSource['saveView']>>>()
        const deleting = deferred<Awaited<ReturnType<DataSource['deleteView']>>>()
        vi.mocked(f.source.saveView).mockImplementation(() => saving.promise)
        vi.mocked(f.source.deleteView).mockImplementation(() => deleting.promise)
        await render(<DataBrowser source={f.source} />)
        await screen.findByText('Owner alpha')
        await click(screen.getByRole('button', { name: action === 'add' ? 'Add table view' : 'Delete alpha view' }))
        await switchTable('Beta', 'Owner beta')
        expect(screen.getByLabelText('Active view').textContent).toBe('beta-view')
        // Return before the mutation resolves, so the old owner must be reloaded on success.
        await switchTable('Alpha', 'Owner alpha')
        await act(async () => {
            f.views.alpha = action === 'add' ? [view('alpha'), added] : []
            if (action === 'add') saving.resolve({ success: true, view: added })
            else deleting.resolve({ success: true })
        })
        if (action === 'add') await screen.findByText('Alpha saved')
        else await waitFor(() => expect(screen.queryByText('alpha view')).toBeNull())
        await switchTable('Beta', 'Owner beta')
        expect(screen.getByText('beta view')).toBeTruthy()
        expect(screen.queryByText('Alpha saved')).toBeNull()
        expect(screen.getByLabelText('Active view').textContent).toBe('beta-view')
    })

    it('does not let a cancelled settings save close the replacement editor or select its stale result', async () => {
        const f = fixture(), pending = deferred<Awaited<ReturnType<DataSource['saveView']>>>()
        vi.mocked(f.source.saveView).mockImplementation(() => pending.promise)
        await render(<DataBrowser source={f.source} />)
        await screen.findByText('Owner alpha')
        await click(screen.getByRole('button', { name: 'Edit alpha view' }))
        await click(screen.getByRole('button', { name: 'Save settings' }))
        await click(screen.getByRole('button', { name: 'Cancel settings' }))
        await click(screen.getByRole('button', { name: 'All rows' }))
        await click(screen.getByRole('button', { name: 'Edit alpha view' }))
        await act(async () => { pending.resolve({ success: true, view: view('alpha', 'Saved settings') }) })
        expect(screen.getByRole('dialog', { name: 'View settings' })).toBeTruthy()
        expect(screen.getByLabelText('Active view').textContent).toBe('__all')
        expect(screen.getByText('Saved settings')).toBeTruthy()
    })

    it('does not show a cancelled settings failure in the replacement editor', async () => {
        const f = fixture(), pending = deferred<Awaited<ReturnType<DataSource['saveView']>>>()
        vi.mocked(f.source.saveView).mockImplementation(() => pending.promise)
        await render(<DataBrowser source={f.source} />)
        await screen.findByText('Owner alpha')
        await click(screen.getByRole('button', { name: 'Edit alpha view' }))
        await click(screen.getByRole('button', { name: 'Save settings' }))
        await click(screen.getByRole('button', { name: 'Cancel settings' }))
        await click(screen.getByRole('button', { name: 'Edit alpha view' }))
        await act(async () => { pending.resolve({ success: false, error: 'Old editor failure' }) })
        expect(screen.getByRole('dialog', { name: 'View settings' })).toBeTruthy()
        expect(screen.queryByText('Old editor failure')).toBeNull()
    })

    it('does not publish a saved view from the previous database', async () => {
        const a = fixture('First'), b = fixture('Second'), pending = deferred<Awaited<ReturnType<DataSource['saveView']>>>()
        vi.mocked(a.source.saveView).mockImplementation(() => pending.promise)
        const mounted = await render(<DataBrowser source={a.source} />)
        await screen.findByText('First alpha')
        await click(screen.getByRole('button', { name: 'Add table view' }))
        await mounted.rerender(<DataBrowser source={b.source} />)
        await screen.findByText('Second alpha')
        await act(async () => { pending.resolve({ success: true, view: { ...view('alpha', 'First private view'), id: 'first-private' } }) })
        expect(screen.queryByText('First private view')).toBeNull()
        expect(screen.getByLabelText('Active view').textContent).toBe('alpha-view')
        expect(window.localStorage.getItem('rerun:data-view:Second:alpha')).toBeNull()
    })

    it.each(['purge', 'delete'] as const)('ignores a %s failure from the previous table and resets the new table busy state', async action => {
        const f = fixture(), pending = deferred<Awaited<ReturnType<DataSource['purgeTable']>>>()
        vi.mocked(f.source.purgeTable).mockImplementation(() => pending.promise)
        vi.mocked(f.source.deleteRows).mockImplementation(() => pending.promise)
        await render(<DataBrowser source={f.source} />)
        await screen.findByText('Owner alpha')
        if (action === 'purge') {
            await click(screen.getByRole('button', { name: 'Purge table' }))
            await click(screen.getByRole('button', { name: 'Confirm purge' }))
        } else {
            await click(screen.getByRole('button', { name: 'Select row' }))
            await click(screen.getByRole('button', { name: 'Delete selected' }))
        }
        await switchTable('Beta', 'Owner beta')
        expect((screen.getByRole('button', { name: 'Purge table' }) as HTMLButtonElement).disabled).toBe(false)
        await act(async () => { pending.resolve({ success: false, error: 'Alpha purge failed' }) })
        expect(screen.queryByText('Alpha purge failed')).toBeNull()
        expect(screen.getByText('Owner beta')).toBeTruthy()
    })

    it.each(['table', 'source'] as const)('keeps a successful delayed drop from closing the current %s owner', async destination => {
        const a = fixture('First'), b = fixture('Second'), pending = deferred<Awaited<ReturnType<DataSource['dropTable']>>>()
        vi.mocked(a.source.dropTable).mockImplementation(() => pending.promise)
        const onTableDropped = vi.fn()
        const mounted = await render(<DataBrowser source={a.source} onTableDropped={onTableDropped} />)
        await screen.findByText('First alpha')
        await click(screen.getByRole('button', { name: 'Drop table' }))
        await click(screen.getByRole('button', { name: 'Confirm drop' }))
        if (destination === 'table') await switchTable('Beta', 'First beta')
        else { await mounted.rerender(<DataBrowser source={b.source} onTableDropped={onTableDropped} />); await screen.findByText('Second alpha') }
        const reads = vi.mocked(a.source.listTables).mock.calls.length
        await act(async () => {
            vi.mocked(a.source.listTables).mockResolvedValue([{ name: 'beta', columns: [{ name: 'body', type: 'TEXT', pk: false, notnull: false }] }])
            pending.resolve({ success: true })
        })
        expect(onTableDropped).not.toHaveBeenCalled()
        expect(await screen.findByText(destination === 'table' ? 'First beta' : 'Second alpha')).toBeTruthy()
        expect(vi.mocked(a.source.listTables).mock.calls.length).toBe(reads + (destination === 'table' ? 1 : 0))
    })
})

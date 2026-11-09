// @vitest-environment happy-dom
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { TableView } from '@rerun/contracts'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DataSource } from '@/lib/data/source'
import type { DbRow } from './DataBrowserTable'

vi.mock('@dnd-kit/core', () => ({
    DndContext: ({ children }: { children: ReactNode }) => <>{children}</>,
    DragOverlay: ({ children }: { children: ReactNode }) => <>{children}</>,
    KeyboardSensor: class {}, PointerSensor: class {}, useSensor: () => ({}), useSensors: () => [],
    useDroppable: () => ({ setNodeRef: () => {}, isOver: false }),
    useDraggable: () => ({ setNodeRef: () => {}, listeners: {}, attributes: {}, isDragging: false }),
}))
vi.mock('@rerun/ui/chat', async importOriginal => ({
    ...await importOriginal<typeof import('@rerun/ui/chat')>(),
    BoardColumnHeader: ({ value, total }: { value: string; total: number }) => <h2>{value}: {total}</h2>,
    BoardItem: ({ row }: { row: DbRow }) => <span>{String(row.body)}</span>,
    ListItem: ({ row }: { row: DbRow }) => <span>{String(row.body)}</span>,
    GalleryItem: ({ row }: { row: DbRow }) => <span>{String(row.body)}</span>,
}))
vi.mock('@/components/ui/sheet', () => ({
    Sheet: ({ open, onOpenChange, children }: { open: boolean; onOpenChange: (open: boolean) => void; children: ReactNode }) => (
        open ? <div role="dialog">{children}<button onClick={() => onOpenChange(false)}>Close row</button></div> : null
    ),
    SheetContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
    SheetHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
    SheetTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
    SheetDescription: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}))
vi.mock('@/components/ui/dropdown-menu', () => ({
    DropdownMenu: ({ children }: { children: ReactNode }) => <div>{children}</div>,
    DropdownMenuTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
    DropdownMenuContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
    DropdownMenuItem: ({ children, onSelect }: { children: ReactNode; onSelect: () => void }) => <button onClick={onSelect}>{children}</button>,
}))
vi.mock('@/components/dialogs/DeleteTableDialog', () => ({ DeleteTableDialog: () => null }))
vi.mock('@/components/dialogs/PurgeTableDialog', () => ({ PurgeTableDialog: () => null }))
vi.mock('@/components/dialogs/ViewSettingsDialog', () => ({ ViewSettingsDialog: () => null }))
vi.mock('@/components/data/DataBrowserPagination', () => ({ DataBrowserPagination: () => null }))
vi.mock('@/components/data/DataBrowserToolbar', () => ({
    DataBrowserToolbar: ({ onSearchChange }: { onSearchChange: (value: string) => void }) => <button onClick={() => onSearchChange('zzz')}>Search rows</button>,
}))
vi.mock('@/components/data/DataBrowserTable', () => ({
    rowKey: (row: DbRow) => (row.__rowid == null ? null : String(row.__rowid)),
    DataBrowserTable: ({ table, onEditCell }: { table: { getRowModel: () => { rows: { id: string; original: DbRow }[] } }; onEditCell: (row: DbRow, column: string, value: string) => Promise<boolean> }) => (
        <div>
            {table.getRowModel().rows.map(row => (
                <div key={row.id}>
                    <span>{String(row.original.body)}</span>
                    <button onClick={() => void onEditCell(row.original, 'body', 'Saved alpha')}>Save row</button>
                </div>
            ))}
        </div>
    ),
}))
vi.mock('@/components/data/DataViewBar', () => ({
    DataViewBar: ({ views, activeId, actions, onSelect }: { views: TableView[]; activeId: string; actions?: ReactNode; onSelect: (id: string) => void }) => (
        <div>
            <output aria-label="Active view">{activeId}</output>
            {views.map(view => <button key={view.id} onClick={() => onSelect(view.id)}>Select {view.name}</button>)}
            {actions}
        </div>
    ),
}))

import { DataBrowser } from './DataBrowser'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const mounts = new Map<Root, HTMLDivElement>()
async function render(node: ReactNode) {
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    mounts.set(root, container)
    await act(async () => { root.render(node) })
    return { rerender: (next: ReactNode) => act(async () => { root.render(next) }) }
}
async function cleanup() {
    for (const [root, container] of mounts) {
        await act(async () => { root.unmount() })
        container.remove()
    }
    mounts.clear()
}
async function click(node: HTMLElement) {
    await act(async () => { node.click() })
}
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
    getByText: (value: string) => {
        const node = queryByText(value)
        expect(node, value).not.toBeNull()
        return node!
    },
    findByText: (value: string) => waitFor(() => screen.getByText(value)),
    getByRole: (role: string, name: string) => {
        const nodes = role === 'button' ? document.querySelectorAll<HTMLElement>('button') : document.querySelectorAll<HTMLElement>('[role]')
        const node = [...nodes].find(item => (role === 'button' || item.getAttribute('role') === role) && (item.getAttribute('aria-label') ?? textOf(item)) === name)
        expect(node, `${role}: ${name}`).toBeDefined()
        return node!
    },
}
const detail = () => document.querySelector('[role="dialog"]')

type Layout = 'list' | 'gallery'
const columns = ['body', 'note', 'is_active', 'blank'].map(name => ({ name, type: name === 'is_active' ? 'BOOLEAN' : 'TEXT', pk: false, notnull: false }))

function cardView(table: string, layout: Layout, name = `${table} ${layout}`): TableView {
    return {
        id: `${table}-${layout}`,
        table,
        name,
        layout,
        fields: { title: 'body' },
        where: [{ column: 'note', equals: `${table} private note` }],
        position: 0,
    }
}

function rowFor(table: string, owner: string): DbRow {
    return { __rowid: 1, body: `${owner} ${table}`, note: `${table} private note`, is_active: false, blank: '', status: 'Todo' }
}

function fixture(owner = 'Owner', layouts: Record<string, Layout> = { alpha: 'list', beta: 'list' }) {
    const rows: Record<string, DbRow> = { alpha: rowFor('alpha', owner), beta: rowFor('beta', owner) }
    const views: Record<string, TableView[]> = {
        alpha: [cardView('alpha', layouts.alpha ?? 'list'), { ...cardView('alpha', layouts.alpha ?? 'list'), id: 'alpha-extra', name: 'alpha extra' }],
        beta: [cardView('beta', layouts.beta ?? 'list')],
    }
    const source: DataSource = {
        scope: 'agent',
        storageKey: owner,
        listTables: vi.fn<DataSource['listTables']>(async () => ['alpha', 'beta'].map(name => ({ name, columns }))),
        readRows: vi.fn<DataSource['readRows']>(async (table, params) => {
            const row = rows[table]
            const matches = !!row && !params.q && (params.where ?? []).every(clause => row[clause.column] === clause.equals)
            return { columns: ['body', 'note', 'is_active', 'blank'], rows: matches && row ? [{ ...row }] : [], total: matches ? 1 : 0 }
        }),
        listViews: vi.fn<DataSource['listViews']>(async table => ({ success: true, views: [...views[table]!] })),
        updateRow: vi.fn<DataSource['updateRow']>(async (table, _id, values) => ({ success: true, row: rows[table] = { ...rows[table], ...values } })),
        saveView: vi.fn<DataSource['saveView']>(async (table, input, id) => ({ success: true, view: { ...cardView(table, 'list', input.name), id: id ?? `${table}-new` } })),
        deleteView: vi.fn<DataSource['deleteView']>(async () => ({ success: true })),
        deleteRows: vi.fn<DataSource['deleteRows']>(async () => ({ success: true })),
        dropTable: vi.fn<DataSource['dropTable']>(async () => ({ success: true })),
        purgeTable: vi.fn<DataSource['purgeTable']>(async () => ({ success: true })),
        readGroups: vi.fn<DataSource['readGroups']>(async () => ({ success: true, groups: [{ value: 'Todo', total: 1 }] })),
        exportUrl: () => '/unused',
        unreachableMessage: 'Unavailable',
        emptyTitle: 'Empty',
        emptyDescription: 'Empty',
    }
    return { source, rows, views }
}

async function settleReads(source: DataSource) {
    let count = -1
    for (let attempt = 0; attempt < 20; attempt++) {
        const next = vi.mocked(source.readRows).mock.calls.length
        if (next > 0 && next === count) return next
        count = next
        await act(async () => { await new Promise(resolve => setTimeout(resolve, 5)) })
    }
    return count
}

function assertBounded(source: DataSource) {
    const calls = vi.mocked(source.readRows).mock.calls
    expect(calls.length).toBeGreaterThan(0)
    for (const [, params] of calls) {
        expect(params.limit).toBe(25)
        expect(params.offset).toBe(0)
        expect(params.where?.[0]).toEqual({ column: 'note', equals: 'alpha private note' })
    }
}

beforeEach(() => {
    const stored = new Map<string, string>()
    Object.defineProperty(window, 'localStorage', { configurable: true, value: { getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => { stored.set(key, value) } } })
})
afterEach(async () => { await cleanup(); vi.clearAllMocks() })

describe('DataBrowser row detail', () => {
    it.each(['list', 'gallery'] as const)('opens a %s row onto fields the card hides, without another read', async layout => {
        const f = fixture('Owner', { alpha: layout, beta: 'list' })
        await render(<DataBrowser source={f.source} />)
        await screen.findByText('Owner alpha')
        expect(document.body.textContent).not.toContain('private note')
        const before = await settleReads(f.source)
        assertBounded(f.source)
        await click(screen.getByRole('button', 'Owner alpha'))
        expect(await settleReads(f.source)).toBe(before)
        const dialog = detail()
        expect(dialog?.textContent).toContain('alpha private note')
        expect(dialog?.textContent).toContain('Active')
        expect(dialog?.querySelector('[aria-label="No"]')).not.toBeNull()
        expect(dialog?.textContent).not.toContain('Blank')
        expect(dialog?.textContent).not.toContain('Open the source')
        expect(screen.getByRole('button', 'Owner alpha').textContent).not.toContain('private note')
        await click(screen.getByRole('button', 'Select alpha extra'))
        expect(detail()?.textContent).toContain('alpha private note')
        await click(screen.getByRole('button', 'Search rows'))
        await screen.findByText('No row matches this search.')
        expect(detail()?.textContent).toContain('alpha private note')
        expect(vi.mocked(f.source.readRows).mock.calls.at(-1)?.[1].q).toBe('zzz')
        expect(vi.mocked(f.source.readRows).mock.calls.at(-1)?.[1].limit).toBe(25)
        await click(screen.getByRole('button', 'Close row'))
        expect(detail()).toBeNull()
    })

    it('opens a board card from the bounded lane read and does not read again', async () => {
        const f = fixture()
        f.views.alpha = [{ ...cardView('alpha', 'list'), id: 'alpha-board', name: 'alpha board', layout: 'board', groupBy: 'status', fields: { title: 'body' } }]
        await render(<DataBrowser source={f.source} />)
        await screen.findByText('Owner alpha')
        const before = await settleReads(f.source)
        const calls = vi.mocked(f.source.readRows).mock.calls
        expect(calls.some(([, params]) => params.where?.some(clause => clause.column === 'status' && clause.equals === 'Todo'))).toBe(true)
        assertBounded(f.source)
        const card = screen.getByText('Owner alpha')
        await click(card.closest('div') ?? card)
        expect(await settleReads(f.source)).toBe(before)
        expect(detail()?.textContent).toContain('alpha private note')
        expect(detail()?.querySelector('[aria-label="No"]')).not.toBeNull()
        expect(screen.getByText('Owner alpha').textContent).not.toContain('private note')
    })

    it('drops a stale detail when the same row id belongs to the next table', async () => {
        const f = fixture()
        await render(<DataBrowser source={f.source} />)
        await screen.findByText('Owner alpha')
        await click(screen.getByRole('button', 'Owner alpha'))
        expect(detail()?.textContent).toContain('alpha private note')
        await click(screen.getByRole('button', 'Beta'))
        await screen.findByText('Owner beta')
        expect(detail()).toBeNull()
        expect(document.body.textContent).not.toContain('private note')
    })

    it('drops a stale detail when the database source changes', async () => {
        const first = fixture('First')
        const second = fixture('Second')
        const mounted = await render(<DataBrowser source={first.source} />)
        await screen.findByText('First alpha')
        await click(screen.getByRole('button', 'First alpha'))
        expect(detail()?.textContent).toContain('alpha private note')
        await mounted.rerender(<DataBrowser source={second.source} />)
        await screen.findByText('Second alpha')
        expect(detail()).toBeNull()
        expect(document.body.textContent).not.toContain('private note')
    })

    it('keeps a table save on the cell and does not open the detail', async () => {
        const f = fixture()
        f.views.alpha = [{ id: 'alpha-table', table: 'alpha', name: 'alpha table', layout: 'table', columns: ['body'], where: [{ column: 'note', equals: 'alpha private note' }], position: 0 }]
        await render(<DataBrowser source={f.source} />)
        await screen.findByText('Owner alpha')
        await settleReads(f.source)
        assertBounded(f.source)
        await click(screen.getByRole('button', 'Save row'))
        expect(f.source.updateRow).toHaveBeenCalledWith('alpha', '1', { body: 'Saved alpha' })
        expect(detail()).toBeNull()
        expect(document.body.textContent).not.toContain('private note')
    })
})

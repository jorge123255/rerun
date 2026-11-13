// @vitest-environment happy-dom
import { act, type ComponentProps, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DragEndEvent } from '@dnd-kit/core'
import type { TableView } from '@rerun/contracts'
import type { DataSource } from '@/lib/data/source'

const dnd = vi.hoisted(() => ({ end: null as null | ((event: DragEndEvent) => void), dragging: false }))
vi.mock('@dnd-kit/core', () => ({
    DndContext: ({ children, onDragEnd }: { children: ReactNode; onDragEnd: (event: DragEndEvent) => void }) => { dnd.end = onDragEnd; return <>{children}</> },
    DragOverlay: ({ children }: { children: ReactNode }) => <>{children}</>,
    KeyboardSensor: class {}, PointerSensor: class {}, useSensor: () => ({}), useSensors: () => [],
    useDroppable: () => ({ setNodeRef: () => {}, isOver: false }),
    useDraggable: ({ disabled }: { disabled: boolean }) => ({ setNodeRef: () => {}, listeners: {}, attributes: { 'data-drag-disabled': String(disabled) }, isDragging: dnd.dragging }),
}))
vi.mock('@/components/data/DataBrowserTable', () => ({ rowKey: (row: Record<string, unknown>) => row.__rowid == null ? null : String(row.__rowid) }))
vi.mock('@rerun/ui/chat', () => ({
    BoardColumnHeader: ({ value, total }: { value: string; total: number }) => <h2>{value}: {total}</h2>,
    BoardItem: ({ row }: { row: Record<string, unknown> }) => <span>{String(row.title)}</span>,
}))
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))
import { toast } from 'sonner'
import { ViewBoard } from './ViewBoard'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
type Row = { __rowid: number; title: string; status: string }
const row = (title: string, id = 1, status = 'Todo'): Row => ({ __rowid: id, title, status })
const boardView: TableView & { groupBy: string } = { id: 'board', table: 'alpha', name: 'Board', layout: 'board', groupBy: 'status', fields: { title: 'title' }, position: 0 }
function deferred<T>() {
    let resolve!: (value: T) => void
    const promise = new Promise<T>(done => { resolve = done })
    return { promise, resolve }
}
function fixture(title = 'Original row') {
    const state = { rows: [row(title)] }
    const source: DataSource = {
        scope: 'agent', storageKey: title,
        listTables: vi.fn<DataSource['listTables']>(async () => []),
        readRows: vi.fn<DataSource['readRows']>(async (_table, params) => ({
            columns: ['title', 'status'], rows: state.rows.filter(item => item.status === params.where?.at(-1)?.equals).map(item => ({ ...item })), total: state.rows.length,
        })),
        readGroups: vi.fn<DataSource['readGroups']>(async () => ({ success: true, groups: ['Todo', 'Done'].map(value => ({ value, total: state.rows.filter(item => item.status === value).length + (value === 'Todo' ? 25 : 0) })) })),
        updateRow: vi.fn<DataSource['updateRow']>(async (_table, id, values) => {
            const target = state.rows.find(item => String(item.__rowid) === String(id))!
            Object.assign(target, values)
            return { success: true, row: { ...target } }
        }),
        listViews: vi.fn<DataSource['listViews']>(async () => ({ success: true, views: [] })),
        saveView: vi.fn<DataSource['saveView']>(async () => ({ success: true, view: boardView })),
        deleteView: vi.fn<DataSource['deleteView']>(async () => ({ success: true })),
        deleteRows: vi.fn<DataSource['deleteRows']>(async () => ({ success: true })),
        dropTable: vi.fn<DataSource['dropTable']>(async () => ({ success: true })),
        purgeTable: vi.fn<DataSource['purgeTable']>(async () => ({ success: true })),
        exportUrl: () => '/unused', unreachableMessage: 'Unavailable', emptyTitle: 'Empty', emptyDescription: 'Empty',
    }
    return { source, state }
}
let root: Root, container: HTMLDivElement, props: ComponentProps<typeof ViewBoard>
beforeEach(() => {
    container = document.createElement('div'); document.body.append(container); root = createRoot(container)
    props = { source: fixture().source, table: 'alpha', view: boardView, query: '', refreshKey: 0, context: {} }
    dnd.end = null; dnd.dragging = false; vi.clearAllMocks()
})
afterEach(async () => { await act(async () => { root.unmount() }); container.remove() })
const render = async (patch: Partial<ComponentProps<typeof ViewBoard>>) => {
    props = { ...props, ...patch }
    await act(async () => { root.render(<ViewBoard {...props} />) })
}
const showMore = async () => {
    const button = [...container.querySelectorAll('button')].find(item => /^Show \d+ more$/.test(item.textContent ?? ''))
    expect(button).toBeDefined()
    await act(async () => { button!.click() })
}
const move = (item: Row, from = 'Todo', to = 'Done') => {
    expect(dnd.end).not.toBeNull()
    dnd.end!({ active: { data: { current: { row: item, from: JSON.stringify(from) } } }, over: { id: JSON.stringify(to) } } as unknown as DragEndEvent)
}

describe('ViewBoard current view ownership', () => {
    it('marks Escape during a drag as handled before it reaches a parent panel', async () => {
        dnd.dragging = true
        await render({})
        const card = container.querySelector('[data-drag-disabled]')!
        const parent = vi.fn()
        container.addEventListener('keydown', parent)
        const escape = () => new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
        const duringDrag = escape()
        await act(async () => { card.dispatchEvent(duringDrag) })
        expect(duringDrag.defaultPrevented).toBe(true)
        expect(parent).toHaveBeenCalledExactlyOnceWith(duringDrag)

        dnd.dragging = false
        await render({})
        const afterDrag = escape()
        await act(async () => { card.dispatchEvent(afterDrag) })
        expect(afterDrag.defaultPrevented).toBe(false)
    })

    it('opens the focused row on Enter without using the drag gesture', async () => {
        const onOpenRow = vi.fn()
        await render({ onOpenRow })
        const card = container.querySelector('[data-drag-disabled]')!
        const press = (key: string, init: KeyboardEventInit = {}) => act(async () => {
            card.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }))
        })
        await press(' ')
        await press('Enter', { isComposing: true })
        await press('Enter', { repeat: true })
        expect(onOpenRow).not.toHaveBeenCalled()
        await press('Enter')
        expect(onOpenRow).toHaveBeenCalledExactlyOnceWith(row('Original row'), card)
        expect(props.source.updateRow).not.toHaveBeenCalled()
    })

    it.each(['source', 'table', 'view', 'query', 'refresh'] as const)('does not publish a late Show more response after a %s change', async changed => {
        const f = fixture(), pending = deferred<Awaited<ReturnType<DataSource['readRows']>>>()
        const read = f.source.readRows
        vi.mocked(f.source.readRows).mockImplementation((table, params) => params.limit > 25 ? pending.promise : Promise.resolve({ columns: ['title', 'status'], rows: f.state.rows.map(item => ({ ...item })), total: 1 }))
        await render({ source: f.source })
        expect(container.textContent).toContain('Original row')
        await showMore()
        f.state.rows = [row('Current row')]
        const next = fixture('Current row')
        await render(changed === 'source' ? { source: next.source } : changed === 'table' ? { table: 'beta' } : changed === 'view' ? { view: { ...boardView, id: 'new-view' } } : changed === 'query' ? { query: 'filtered' } : { refreshKey: 1 })
        expect(container.textContent).toContain('Current row')
        await act(async () => { pending.resolve({ columns: ['title', 'status'], rows: [row('Old extra rows')], total: 1 }) })
        expect(container.textContent).toContain('Current row')
        expect(container.textContent).not.toContain('Old extra rows')
        expect(read).toHaveBeenCalled()
    })

    it.each(['table', 'query'] as const)('does not roll a failed old move back into a new %s', async changed => {
        const f = fixture(), pending = deferred<Awaited<ReturnType<DataSource['updateRow']>>>()
        vi.mocked(f.source.updateRow).mockImplementation(() => pending.promise)
        await render({ source: f.source })
        await act(async () => { move(row('Original row')) })
        f.state.rows = [row('Current row', 7)]
        await render(changed === 'table' ? { table: 'beta' } : { query: 'new query' })
        expect(container.textContent).toContain('Current row')
        await act(async () => { pending.resolve({ success: false, error: 'Old failure' }) })
        expect(container.textContent).toContain('Current row')
        expect(container.textContent).not.toContain('Original row')
        expect(toast.error).not.toHaveBeenCalled()
    })

    it('admits only one move until it settles, reloads a failure, then keeps the next successful move', async () => {
        const f = fixture(), pending = deferred<Awaited<ReturnType<DataSource['updateRow']>>>()
        const onRowsChanged = vi.fn()
        const update = vi.mocked(f.source.updateRow)
        update.mockImplementationOnce(() => pending.promise)
        await render({ source: f.source, onRowsChanged })
        expect(onRowsChanged).not.toHaveBeenCalled()
        await act(async () => { move(row('Original row')); move(row('Original row'), 'Done', 'Todo') })
        expect(update).toHaveBeenCalledTimes(1)
        expect(container.querySelector('[data-drag-disabled="true"]')).not.toBeNull()
        f.state.rows = [row('Current server row', 9)]
        await act(async () => { pending.resolve({ success: false, error: 'Conflict' }) })
        expect(container.textContent).toContain('Current server row')
        expect(container.textContent).not.toContain('Original row')
        expect(container.querySelector('[data-drag-disabled="false"]')).not.toBeNull()
        expect(onRowsChanged).not.toHaveBeenCalled()
        await act(async () => { move(row('Current server row', 9)) })
        expect(update).toHaveBeenCalledTimes(2)
        expect(f.state.rows[0]!.status).toBe('Done')
        expect(container.textContent).toContain('Done: 1')
        expect(container.textContent).toContain('Current server row')
        expect(onRowsChanged).toHaveBeenCalledTimes(1)
    })

    it('coalesces same-lane Show more and blocks moves until that snapshot finishes', async () => {
        const f = fixture(), pending = deferred<Awaited<ReturnType<DataSource['readRows']>>>()
        vi.mocked(f.source.readRows).mockImplementation((_table, params) => params.limit > 25 ? pending.promise : Promise.resolve({ columns: ['title', 'status'], rows: [row('Original row')], total: 1 }))
        await render({ source: f.source })
        await showMore()
        await showMore()
        await act(async () => { move(row('Original row')) })
        expect(vi.mocked(f.source.readRows).mock.calls.filter(([, params]) => params.limit > 25)).toHaveLength(1)
        expect(f.source.updateRow).not.toHaveBeenCalled()
        await act(async () => { pending.resolve({ columns: ['title', 'status'], rows: [row('More rows')], total: 1 }) })
        expect(container.textContent).toContain('More rows')
        expect(container.querySelector('[data-drag-disabled="false"]')).not.toBeNull()
    })
})

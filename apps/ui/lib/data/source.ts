import { deleteTableViewAction, listTableViewsAction, readTableGroupsAction, saveTableViewAction, updateTableRowAction } from '@/app/api/_actions/data-views.actions'
import type { EngineDbRows, EngineDbTable } from '@/lib/engine/types'
import type { EngineDbGroup, RowFilter, TableView, TableViewInput } from '@rerun/contracts'

export type DataScope = { kind: 'agent'; agentId: string } | { kind: 'shared' }

export type DataReadParams = { limit: number; offset: number; sort?: string; dir?: 'asc' | 'desc'; q?: string; where?: RowFilter[] }
export type DataExportParams = { format: 'csv' | 'json'; sort?: string; dir?: 'asc' | 'desc'; q?: string; where?: RowFilter[] }
export type DataGroupParams = { groupBy: string; sum?: string; q?: string; where?: RowFilter[] }
export type SqlValue = string | number | boolean | null

/** Where a chat card asks the browser to land: a table, and the view it was drawn from. */
export type DataFocus = { table: string; view?: string }

type Result<T = object> = ({ success: true } & T) | { success: false; error: string }

// The browser is handed bound server actions rather than an id and a scope flag, so it stays
// unaware of who owns the database it renders: ownership is settled in the actions alone.
export type DataSource = {
    /** Which database this is, for the badge of a preview. */
    scope: DataScope['kind']
    /** Distinguishes this database when the last view opened on each table is remembered. */
    storageKey: string
    /** Hosted sources support table cards by default; limited clients can hide that promise. */
    supportsTableCards?: boolean
    listTables: () => Promise<EngineDbTable[]>
    readRows: (table: string, params: DataReadParams) => Promise<EngineDbRows | null>
    deleteRows: (table: string, rowids: (number | string)[]) => Promise<{ success: boolean; error?: string; deleted?: number }>
    dropTable: (table: string) => Promise<{ success: boolean; error?: string }>
    purgeTable: (table: string) => Promise<{ success: boolean; error?: string; deleted?: number }>
    exportUrl: (table: string, params: DataExportParams) => string
    /** Local shells can save an authenticated response without opening another window. */
    exportFile?: (table: string, params: DataExportParams, signal: AbortSignal) => Promise<void>
    listViews: (table: string) => Promise<Result<{ views: TableView[] }>>
    saveView: (table: string, input: TableViewInput, id?: string) => Promise<Result<{ view: TableView }>>
    deleteView: (table: string, id: string) => Promise<Result>
    readGroups: (table: string, params: DataGroupParams) => Promise<Result<{ groups: EngineDbGroup[] }>>
    updateRow: (table: string, rowid: number | string, values: Record<string, SqlValue>) => Promise<Result<{ row: Record<string, unknown> }>>
    /** Turns a workspace file path stored in a cell into a URL, for images. Agent databases only. */
    fileUrl?: (path: string) => string | null
    unreachableMessage: string
    emptyTitle: string
    emptyDescription: string
}

export function viewActions(scope: DataScope): Pick<DataSource, 'listViews' | 'saveView' | 'deleteView' | 'readGroups' | 'updateRow'> {
    return {
        listViews: table => listTableViewsAction(scope, table),
        saveView: (table, input, id) => saveTableViewAction(scope, table, input, id),
        deleteView: (table, id) => deleteTableViewAction(scope, table, id),
        readGroups: (table, params) => readTableGroupsAction(scope, table, params),
        updateRow: (table, rowid, values) => updateTableRowAction(scope, table, rowid, values),
    }
}

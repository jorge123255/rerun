import type { DataExportParams, DataReadParams, DataSource } from '@/lib/data/source'
import type { EngineDbRows, EngineDbTable } from '@rerun/contracts'
import { desktopViewActions } from './data-views'
import { desktopDataBase, desktopDataExportUrl, desktopDataStorageKey, type DesktopDataScope } from './data-scope'
import { saveDesktopDataExport } from './data-export'
import { desktopPreferredView } from './data-preferences'

type DeleteResult = { success: boolean; error?: string; deleted?: number }
type ChangeResult = { success: boolean; error?: string }

const IMAGE = /\.(?:png|jpe?g|webp|gif)$/i

/**
 * A bounded, authenticated URL for an image a cell names. Only this coworker's Files are
 * reachable: the shared database has no image path on this Mac, so it gets no resolver at all.
 */
function desktopFileUrl(scope: DesktopDataScope, path: string): string | null {
    if (scope.kind !== 'agent' || !IMAGE.test(path)) return null
    if (!path || path.startsWith('/') || path.split('/').includes('..')) return null
    return `/api/desktop/agents/${encodeURIComponent(scope.agentId)}/files/image?path=${encodeURIComponent(path)}`
}

/**
 * The original DataBrowser, bound to one database through the desktop adapter.
 *
 * Nothing here decides which database it is: the scope was fixed when the panel opened, and the
 * base URL carries it. A coworker's private database and the workspace shared one never share a
 * base, a storage key or a permission.
 */
export function desktopDataSource(scope: DesktopDataScope): DataSource {
    const base = desktopDataBase(scope)
    const tableUrl = (table: string) => `${base}/tables/${encodeURIComponent(table)}`

    async function readJson<T>(url: string, init: RequestInit, fallback: string): Promise<T> {
        const response = await fetch(url, { cache: 'no-store', ...init })
        const body = await response.json().catch(() => null)
        if (!response.ok) throw new Error(typeof body?.error === 'string' && body.error ? body.error : fallback)
        return body as T
    }

    async function change(url: string, init: RequestInit, fallback: string): Promise<DeleteResult> {
        try {
            const body = await readJson<{ deleted?: number }>(url, init, fallback)
            return { success: true, ...(typeof body?.deleted === 'number' ? { deleted: body.deleted } : {}) }
        } catch (error) {
            return { success: false, error: error instanceof Error && error.message ? error.message : fallback }
        }
    }

    return {
        scope: scope.kind,
        storageKey: desktopDataStorageKey(scope),
        preferredView: desktopPreferredView(scope),
        supportsTableCards: false,
        listTables: async (): Promise<EngineDbTable[]> => {
            const { tables } = await readJson<{ tables: EngineDbTable[] }>(base, { method: 'GET' }, 'Could not reach this database.')
            return tables
        },
        readRows: async (table: string, params: DataReadParams): Promise<EngineDbRows | null> => {
            const qs = new URLSearchParams({ limit: String(params.limit), offset: String(params.offset) })
            if (params.sort) qs.set('sort', params.sort)
            if (params.dir) qs.set('dir', params.dir)
            if (params.q) qs.set('q', params.q)
            if (params.where?.length) qs.set('where', JSON.stringify(params.where))
            try {
                return await readJson<EngineDbRows>(`${tableUrl(table)}/rows?${qs.toString()}`, { method: 'GET' }, 'Could not read this table.')
            } catch {
                return null
            }
        },
        deleteRows: (table: string, rowids: (number | string)[]): Promise<DeleteResult> =>
            change(`${tableUrl(table)}/rows`, {
                method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ rowids }),
            }, 'Could not delete those rows.'),
        dropTable: async (table: string): Promise<ChangeResult> => {
            try {
                await readJson<unknown>(tableUrl(table), { method: 'DELETE' }, 'Could not delete this table.')
                return { success: true }
            } catch (error) {
                return { success: false, error: error instanceof Error && error.message ? error.message : 'Could not delete this table.' }
            }
        },
        purgeTable: (table: string): Promise<DeleteResult> => change(`${tableUrl(table)}/purge`, { method: 'POST' }, 'Could not purge this table.'),
        exportUrl: (table: string, params: DataExportParams) => desktopDataExportUrl(scope, table, params),
        exportFile: (table, params, signal) => saveDesktopDataExport(desktopDataExportUrl(scope, table, params), table, params.format, signal),
        ...desktopViewActions(scope),
        ...(scope.kind === 'agent' ? { fileUrl: (path: string) => desktopFileUrl(scope, path) } : {}),
        unreachableMessage: scope.kind === 'agent' ? 'Could not reach this coworker’s database.' : 'Could not reach the workspace database.',
        emptyTitle: scope.kind === 'agent' ? 'No tables yet' : 'No shared tables yet',
        emptyDescription: scope.kind === 'agent'
            ? 'This coworker has its own private database. When it needs to store structured data (contacts, results, tracking lists), it creates tables here that you can browse anytime.'
            : 'Coworkers with shared database permission read and write this database. When they need a common record (a catalog, a queue, a list several coworkers work through), they create tables here that you can browse anytime.',
    }
}

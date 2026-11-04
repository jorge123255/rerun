import type { DataGroupParams, DataSource, SqlValue } from '@/lib/data/source'
import type { EngineDbGroup, TableView, TableViewInput } from '@rerun/contracts'
import { desktopDataBase, type DesktopDataScope } from './data-scope'

type Result<T = object> = ({ success: true } & T) | { success: false; error: string }

/**
 * The saved views and row edits of one table, addressed through the authenticated desktop
 * adapter. This mirrors the web `viewActions`, but no server action is reachable from the Mac
 * renderer: every call is a same-origin request to the scope's own prefix.
 */
export function desktopViewActions(scope: DesktopDataScope): Pick<DataSource, 'listViews' | 'saveView' | 'deleteView' | 'readGroups' | 'updateRow'> {
    const base = desktopDataBase(scope)
    const tableUrl = (table: string) => `${base}/tables/${encodeURIComponent(table)}`

    async function call<T>(url: string, init: RequestInit, fallback: string): Promise<T> {
        try {
            const response = await fetch(url, { cache: 'no-store', ...init })
            const body = await response.json().catch(() => null)
            if (!response.ok) throw new Error(typeof body?.error === 'string' && body.error ? body.error : fallback)
            return body as T
        } catch (error) {
            throw new Error(error instanceof Error && error.message ? error.message : fallback)
        }
    }

    const json = (body: unknown): RequestInit => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

    return {
        listViews: async (table): Promise<Result<{ views: TableView[] }>> => {
            try {
                const { views } = await call<{ views: TableView[] }>(`${tableUrl(table)}/views`, { method: 'GET' }, 'Could not read the views of this table.')
                return { success: true, views }
            } catch (error) {
                return { success: false, error: error instanceof Error ? error.message : 'Could not read the views of this table.' }
            }
        },
        saveView: async (table, input: TableViewInput, id?: string): Promise<Result<{ view: TableView }>> => {
            try {
                const { view } = await call<{ view: TableView }>(`${tableUrl(table)}/views${id ? `/${encodeURIComponent(id)}` : ''}`,
                    { ...json(input), method: id ? 'PUT' : 'POST' }, 'Could not save the view.')
                return { success: true, view }
            } catch (error) {
                return { success: false, error: error instanceof Error ? error.message : 'Could not save the view.' }
            }
        },
        deleteView: async (table, id): Promise<Result> => {
            try {
                await call<unknown>(`${tableUrl(table)}/views/${encodeURIComponent(id)}`, { method: 'DELETE' }, 'Could not delete this view.')
                return { success: true }
            } catch (error) {
                return { success: false, error: error instanceof Error ? error.message : 'Could not delete this view.' }
            }
        },
        readGroups: async (table, params: DataGroupParams): Promise<Result<{ groups: EngineDbGroup[] }>> => {
            const qs = new URLSearchParams({ groupBy: params.groupBy })
            if (params.sum) qs.set('sum', params.sum)
            if (params.q) qs.set('q', params.q)
            if (params.where?.length) qs.set('where', JSON.stringify(params.where))
            try {
                const { groups } = await call<{ groups: EngineDbGroup[] }>(`${tableUrl(table)}/groups?${qs.toString()}`, { method: 'GET' }, 'Could not group the rows.')
                return { success: true, groups }
            } catch (error) {
                return { success: false, error: error instanceof Error ? error.message : 'Could not group the rows.' }
            }
        },
        updateRow: async (table, rowid: number | string, values: Record<string, SqlValue>): Promise<Result<{ row: Record<string, unknown> }>> => {
            try {
                const { row } = await call<{ row: Record<string, unknown> }>(`${tableUrl(table)}/rows/${encodeURIComponent(String(rowid))}`,
                    { ...json({ values }), method: 'PATCH' }, 'Could not save this row.')
                return { success: true, row }
            } catch (error) {
                return { success: false, error: error instanceof Error ? error.message : 'Could not save this row.' }
            }
        },
    }
}

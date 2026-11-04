import 'server-only'
import { rowFilterSchema, tableViewInputSchema, type EngineDbGroup, type EngineDbRows, type EngineDbTable, type RowFilter, type TableView, type TableViewInput } from '@rerun/contracts'
import { z } from 'zod'
import * as engine from '@/lib/engine/client'
import { EngineRequestError } from '@/lib/engine/client'
import type { EngineConnection } from '@/lib/engine/types'
import {
    clampDesktopOffset,
    clampDesktopPage,
    DESKTOP_DATA_MAX_COLUMNS,
    DESKTOP_DATA_MAX_FILTERS,
    DESKTOP_DATA_MAX_ROWIDS,
    DESKTOP_DATA_TERM_MAX,
    type DesktopDataScope,
} from '../data-scope'
import { DesktopHttpError } from './auth'
import { openDesktopDatabase } from './database'
import type { DesktopRuntime } from './runtime'
import { engineOf } from './settings'
import { findDesktopAgent } from './store'

// The two hidden tables are internal bookkeeping the browser never shows: the saved views of a
// database, and who created a shared table. They are not data a person browses, and their names
// are refused here before the engine is even asked.
const HIDDEN_TABLE = /^(?:_rerun_|sqlite_)/i

const scalar = z.union([z.string().max(50_000), z.number(), z.boolean(), z.null()])
const valuesSchema = z.record(z.string().min(1).max(200), scalar)
const rowUpdateSchema = z.object({ values: valuesSchema })
const rowDeleteSchema = z.object({ rowids: z.array(z.union([z.string().max(200), z.number()])).min(1).max(DESKTOP_DATA_MAX_ROWIDS) })

type Target = { conn: EngineConnection; base: string; scope: DesktopDataScope }

function tableName(raw: string): string {
    if (!raw || raw.length > 200 || /[\u0000-\u001f]/.test(raw)) throw new DesktopHttpError(400, 'Choose a table to open.')
    if (HIDDEN_TABLE.test(raw)) throw new DesktopHttpError(404, 'Table not found.')
    return raw
}

function assertText(value: string | null | undefined, label: string): string | undefined {
    if (value === null || value === undefined) return undefined
    if (value.length > DESKTOP_DATA_TERM_MAX) throw new DesktopHttpError(400, `${label} is too long.`)
    return value
}

function parseFilters(raw: unknown): RowFilter[] | undefined {
    if (raw === null || raw === undefined || raw === '') return undefined
    let parsed: unknown = raw
    if (typeof raw === 'string') {
        try { parsed = JSON.parse(raw) } catch { throw new DesktopHttpError(400, 'That table filter is not valid.') }
    }
    const result = z.array(rowFilterSchema).max(DESKTOP_DATA_MAX_FILTERS).safeParse(parsed)
    if (!result.success || result.data.some(filter => filter.column.length > 200 || (typeof filter.equals === 'string' && filter.equals.length > 50_000))) throw new DesktopHttpError(400, 'That table filter is not valid.')
    return result.data.length > 0 ? result.data : undefined
}

function parseSort(raw: string | null): string | undefined {
    return assertText(raw, 'The sort column')
}

function parseDirection(raw: string | null): 'asc' | 'desc' | undefined {
    return raw === 'desc' ? 'desc' : raw === 'asc' ? 'asc' : undefined
}

/** An agent scope is only reachable through the desktop roster, so a raw engine agent id can
 *  never be addressed from the browser. Each scope addresses exactly one database. */
export async function desktopDataTarget(runtime: DesktopRuntime, scope: DesktopDataScope): Promise<Target> {
    if (scope.kind === 'shared') return { conn: engineOf(runtime), base: engine.SPACE_DATA_BASE, scope }
    const coworker = await findDesktopAgent(await openDesktopDatabase(runtime.dataRoot), scope.agentId)
    if (!coworker) throw new DesktopHttpError(404, 'Coworker not found')
    return { conn: engineOf(runtime), base: engine.agentDataBase(coworker.engineAgentId), scope }
}

function engineMessage(error: EngineRequestError): string | null {
    const body = /failed: \d+ ([\s\S]*)$/.exec(error.message)?.[1]
    if (!body) return null
    try {
        const parsed = JSON.parse(body) as { error?: unknown }
        return typeof parsed.error === 'string' && parsed.error ? parsed.error : null
    } catch {
        return null
    }
}

/**
 * The engine reports a missing table as a bare 500 from its untried routes, which would reach the
 * user as "something failed" for a table that simply is not there. Only on a failure do we list
 * the tables once and turn that into a truthful 404, keeping the happy path one request.
 */
async function withReason<T>(target: Target, table: string, action: () => Promise<T>): Promise<T> {
    try {
        return await action()
    } catch (error) {
        if (!(error instanceof EngineRequestError)) throw error
        const message = engineMessage(error)
        if (error.status === 404) throw new DesktopHttpError(404, message ?? 'Table not found.')
        if (error.status === 409) throw new DesktopHttpError(409, message ?? 'This table changed. Reload it and try again.')
        if (error.status === 400 && message) throw new DesktopHttpError(400, message)
        const listed = await engine.listDbTables(target.conn, target.base).catch(() => null)
        if (listed && !listed.some(candidate => candidate.name === table)) throw new DesktopHttpError(404, 'Table not found.')
        throw new DesktopHttpError(502, message ?? 'The database request failed. Try again.')
    }
}

export async function listDesktopDataTables(runtime: DesktopRuntime, scope: DesktopDataScope): Promise<EngineDbTable[]> {
    const target = await desktopDataTarget(runtime, scope)
    try {
        return (await engine.listDbTables(target.conn, target.base)).filter(table => !HIDDEN_TABLE.test(table.name))
    } catch {
        throw new DesktopHttpError(502, 'Could not reach this database.')
    }
}

export type DesktopRowsQuery = { limit: string | null; offset: string | null; sort: string | null; dir: string | null; q: string | null; where: unknown }

export async function readDesktopDataRows(runtime: DesktopRuntime, scope: DesktopDataScope, rawTable: string, query: DesktopRowsQuery): Promise<EngineDbRows> {
    const table = tableName(rawTable)
    const target = await desktopDataTarget(runtime, scope)
    const params = {
        limit: clampDesktopPage(query.limit === null ? undefined : Number(query.limit)),
        offset: clampDesktopOffset(query.offset === null ? undefined : Number(query.offset)),
        sort: parseSort(query.sort),
        dir: parseDirection(query.dir),
        q: assertText(query.q, 'That search'),
        where: parseFilters(query.where),
    }
    return withReason(target, table, () => engine.readDbTableRows(target.conn, target.base, table, params))
}

export async function readDesktopDataGroups(runtime: DesktopRuntime, scope: DesktopDataScope, rawTable: string, query: { groupBy: string | null; sum: string | null; q: string | null; where: unknown }): Promise<EngineDbGroup[]> {
    const table = tableName(rawTable)
    const groupBy = assertText(query.groupBy, 'The group column')
    if (!groupBy) throw new DesktopHttpError(400, 'Choose a column to group by.')
    const target = await desktopDataTarget(runtime, scope)
    const params = { groupBy, sum: assertText(query.sum, 'The sum column'), q: assertText(query.q, 'That search'), where: parseFilters(query.where) }
    return withReason(target, table, () => engine.readDbTableGroups(target.conn, target.base, table, params))
}

export async function updateDesktopDataRow(runtime: DesktopRuntime, scope: DesktopDataScope, rawTable: string, rowid: string, body: unknown): Promise<Record<string, unknown>> {
    const table = tableName(rawTable)
    if (!rowid || rowid.length > 200) throw new DesktopHttpError(400, 'Choose a row to update.')
    const input = rowUpdateSchema.safeParse(body)
    if (!input.success) throw new DesktopHttpError(400, 'Those values cannot be saved.')
    if (Object.keys(input.data.values).length > DESKTOP_DATA_MAX_COLUMNS) throw new DesktopHttpError(400, 'Too many columns in one change.')
    const target = await desktopDataTarget(runtime, scope)
    return withReason(target, table, () => engine.updateDbTableRow(target.conn, target.base, table, rowid, input.data.values))
}

export async function deleteDesktopDataRows(runtime: DesktopRuntime, scope: DesktopDataScope, rawTable: string, body: unknown): Promise<{ deleted: number }> {
    const table = tableName(rawTable)
    const input = rowDeleteSchema.safeParse(body)
    if (!input.success) throw new DesktopHttpError(400, 'Choose the rows to delete.')
    const target = await desktopDataTarget(runtime, scope)
    return withReason(target, table, () => engine.deleteDbTableRows(target.conn, target.base, table, input.data.rowids))
}

export async function purgeDesktopDataTable(runtime: DesktopRuntime, scope: DesktopDataScope, rawTable: string): Promise<{ deleted: number }> {
    const table = tableName(rawTable)
    const target = await desktopDataTarget(runtime, scope)
    return withReason(target, table, () => engine.purgeDbTable(target.conn, target.base, table))
}

export async function dropDesktopDataTable(runtime: DesktopRuntime, scope: DesktopDataScope, rawTable: string): Promise<void> {
    const table = tableName(rawTable)
    const target = await desktopDataTarget(runtime, scope)
    await withReason(target, table, () => engine.dropDbTable(target.conn, target.base, table))
}

export async function listDesktopDataViews(runtime: DesktopRuntime, scope: DesktopDataScope, rawTable: string): Promise<TableView[]> {
    const table = tableName(rawTable)
    const target = await desktopDataTarget(runtime, scope)
    return withReason(target, table, () => engine.listTableViews(target.conn, target.base, table))
}

export async function saveDesktopDataView(runtime: DesktopRuntime, scope: DesktopDataScope, rawTable: string, body: unknown, viewId?: string): Promise<TableView> {
    const table = tableName(rawTable)
    const parsed = tableViewInputSchema.safeParse(body)
    if (!parsed.success) throw new DesktopHttpError(400, 'That saved view is not valid.')
    const input: TableViewInput = parsed.data
    const target = await desktopDataTarget(runtime, scope)
    return withReason(target, table, () => engine.saveTableView(target.conn, target.base, table, input, viewId))
}

export async function deleteDesktopDataView(runtime: DesktopRuntime, scope: DesktopDataScope, rawTable: string, viewId: string): Promise<void> {
    const table = tableName(rawTable)
    const target = await desktopDataTarget(runtime, scope)
    await withReason(target, table, () => engine.deleteTableView(target.conn, target.base, table, viewId))
}

export async function exportDesktopDataTable(runtime: DesktopRuntime, scope: DesktopDataScope, rawTable: string, query: { format: string | null; sort: string | null; dir: string | null; q: string | null; where: unknown }): Promise<Response> {
    const table = tableName(rawTable)
    if (query.format !== null && !['json', 'csv'].includes(query.format)) throw new DesktopHttpError(400, 'Choose CSV or JSON export.')
    const format = query.format === 'json' ? 'json' : 'csv'
    const params = {
        format,
        sort: parseSort(query.sort),
        dir: parseDirection(query.dir),
        q: assertText(query.q, 'That search'),
        where: parseFilters(query.where),
    } as const
    const target = await desktopDataTarget(runtime, scope)
    const response = await engine.exportDbTable(target.conn, target.base, table, params)
    if (!response.ok || !response.body) {
        const errorBody = await response.json().catch(() => null) as { error?: string } | null
        if (response.status === 413) throw new DesktopHttpError(413, errorBody?.error ?? 'Export is too large. Filter the table and try again.')
        await withReason(target, table, async () => { throw new EngineRequestError(`export failed: ${response.status} ${JSON.stringify(errorBody)}`, response.status) })
        throw new DesktopHttpError(502, 'Could not export this table.')
    }
    return new Response(response.body, { headers: {
        'content-type': response.headers.get('content-type') ?? (format === 'json' ? 'application/json; charset=utf-8' : 'text/csv; charset=utf-8'),
        'content-disposition': response.headers.get('content-disposition') ?? `attachment; filename="data.${format}"; filename*=UTF-8''${encodeURIComponent(table)}.${format}`,
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
    } })
}

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { 'cache-control': 'no-store' } })
const noContent = () => new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } })

/**
 * One authenticated adapter per database, dispatching the few operations the browser needs.
 * There is deliberately no generic SQL entry point: reads are a paginated row window and writes
 * are row, table and saved-view changes. A coworker's own SQL surface lives in its tools.
 */
export async function handleDesktopData(runtime: DesktopRuntime, request: Request, scope: DesktopDataScope, rawSegments: string[]): Promise<Response> {
    const segments = rawSegments.filter(part => part.length > 0)
    const method = request.method
    const url = new URL(request.url)
    const query = url.searchParams

    if (segments.length === 0) {
        if (method !== 'GET') throw new DesktopHttpError(405, 'Method not allowed')
        return json({ tables: await listDesktopDataTables(runtime, scope) })
    }

    if (segments.length === 1 && segments[0] === 'export') {
        if (method !== 'GET') throw new DesktopHttpError(405, 'Method not allowed')
        const table = query.get('table')
        if (!table) throw new DesktopHttpError(400, 'Choose a table to export.')
        return exportDesktopDataTable(runtime, scope, table, { format: query.get('format'), sort: query.get('sort'), dir: query.get('dir'), q: query.get('q'), where: query.get('where') })
    }

    if (segments[0] !== 'tables' || segments.length < 2) throw new DesktopHttpError(404, 'Not found')
    const table = segments[1]!
    const rest = segments.slice(2)

    if (rest.length === 0) {
        if (method !== 'DELETE') throw new DesktopHttpError(405, 'Method not allowed')
        await dropDesktopDataTable(runtime, scope, table)
        return noContent()
    }

    if (rest.length === 1 && rest[0] === 'rows') {
        if (method === 'GET') {
            return json(await readDesktopDataRows(runtime, scope, table, {
                limit: query.get('limit'), offset: query.get('offset'), sort: query.get('sort'), dir: query.get('dir'), q: query.get('q'), where: query.get('where'),
            }))
        }
        if (method === 'DELETE') return json(await deleteDesktopDataRows(runtime, scope, table, await request.json().catch(() => null)))
        throw new DesktopHttpError(405, 'Method not allowed')
    }

    if (rest.length === 2 && rest[0] === 'rows') {
        if (method !== 'PATCH') throw new DesktopHttpError(405, 'Method not allowed')
        return json({ row: await updateDesktopDataRow(runtime, scope, table, rest[1]!, await request.json().catch(() => null)) })
    }

    if (rest.length === 1 && rest[0] === 'purge') {
        if (method !== 'POST') throw new DesktopHttpError(405, 'Method not allowed')
        return json(await purgeDesktopDataTable(runtime, scope, table))
    }

    if (rest.length === 1 && rest[0] === 'groups') {
        if (method !== 'GET') throw new DesktopHttpError(405, 'Method not allowed')
        return json({ groups: await readDesktopDataGroups(runtime, scope, table, {
            groupBy: query.get('groupBy'), sum: query.get('sum'), q: query.get('q'), where: query.get('where'),
        }) })
    }

    if (rest.length === 1 && rest[0] === 'views') {
        if (method === 'GET') return json({ views: await listDesktopDataViews(runtime, scope, table) })
        if (method === 'POST') return json({ view: await saveDesktopDataView(runtime, scope, table, await request.json().catch(() => null)) })
        throw new DesktopHttpError(405, 'Method not allowed')
    }

    if (rest.length === 2 && rest[0] === 'views') {
        const viewId = rest[1]!
        if (method === 'PUT') return json({ view: await saveDesktopDataView(runtime, scope, table, await request.json().catch(() => null), viewId) })
        if (method === 'DELETE') {
            await deleteDesktopDataView(runtime, scope, table, viewId)
            return noContent()
        }
        throw new DesktopHttpError(405, 'Method not allowed')
    }

    throw new DesktopHttpError(404, 'Not found')
}

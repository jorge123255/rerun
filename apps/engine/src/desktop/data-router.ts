import { Hono } from 'hono'
import type { Context } from 'hono'
import type { Client, Transaction } from '@libsql/client'
import { rowFilterSchema, rowUpdateSchema } from '@rerun/contracts'
import { z } from 'zod'
import { createDataRouter } from '../http/routes/data.js'
import { listTables, readTableRows, serializeRow, tableColumns } from '../db/sqlStore.js'
import { assertPlainDataSchema } from './data-store.js'
import { beginDesktopAgentWork } from './agent-lifecycle.js'

const HIDDEN = ['_rerun_views', '_rerun_shared_tables']
const MAX_EXPORT_ROWS = 10_000
const MAX_EXPORT_BYTES = 5_000_000
const internal = (name: string) => /^(?:sqlite_|_rerun_)/i.test(name)
function csv(value: unknown): string {
    let text = value == null ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value)
    // Spreadsheet formula injection: data remains text when the export is opened in a sheet.
    if (/^[\s]*[=+@-]/.test(text)) text = `'${text}`
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

/** Root mounts this in place of createDataRouter only for desktop. Human session routes use
 * explicit operations, not the coworker SQL tools/grants. Every response is committed atomically
 * before it is sent, including row update+readback and table drop+saved-view cleanup. */
export function createDesktopDataRouter(getClient: (context: Context) => Promise<Client>): Hono {
    const app = new Hono()
    app.onError((error, c) => {
        const message = error.message || 'Database request failed.'
        const status = /^(?:Table|Row|View) not found/i.test(message) ? 404 : /already exists|UNIQUE constraint/i.test(message) ? 409 : 400
        return c.json({ error: message }, status)
    })
    const clients = new WeakMap<Context, Client>()
    app.use('*', async (c, next) => {
        // Defense in depth: never mount generic SQL endpoints even if root's policy widens.
        const suffix = c.req.path.split('/data/')[1] ?? ''
        if (suffix === 'query' || suffix === 'execute') return c.json({ error: 'Raw SQL is unavailable in desktop data routes.' }, 404)
        let table: string | undefined
        try { table = suffix.startsWith('tables/') ? decodeURIComponent(suffix.split('/')[1]) : undefined }
        catch { return c.json({ error: 'Invalid table name.' }, 400) }
        if (table && internal(table)) return c.json({ error: 'Table not found.' }, 404)
        const agentId = c.req.param('id')
        const release = agentId ? beginDesktopAgentWork(agentId) : () => {}
        let tx: Transaction
        try { tx = await (await getClient(c)).transaction(c.req.method === 'GET' ? 'read' : 'write') }
        catch (error) { release(); throw error }
        try {
            if (c.req.method === 'GET') await tx.execute('PRAGMA query_only = ON')
            await assertPlainDataSchema(tx)
            // Upstream DataRouter helpers use only execute; Transaction provides that same API.
            clients.set(c, tx as unknown as Client)
            await next()
            if (c.req.method === 'GET' || c.res.status >= 400 || c.error) await tx.rollback()
            else await tx.commit()
        } catch (error) {
            await tx.rollback().catch(() => {})
            return c.json({ error: error instanceof Error ? error.message : 'Database request failed.' }, 400)
        } finally { clients.delete(c); try { tx.close() } finally { release() } }
    })
    const client = async (c: Context) => {
        const tx = clients.get(c)
        if (!tx) throw new Error('Missing desktop data transaction.')
        return tx
    }
    app.get('/tables', async c => {
        const tables = await listTables(await client(c), HIDDEN)
        return c.json({ tables: tables.filter(table => !internal(table.name)) })
    })
    // Full exports are bounded and fail explicitly rather than silently exporting a prefix.
    app.get('/tables/:name/export', async c => {
        const name = c.req.param('name')
        const where = c.req.query('where')
        const result = await readTableRows(await client(c), name, {
            limit: MAX_EXPORT_ROWS + 1, offset: 0, sort: c.req.query('sort'), dir: c.req.query('dir'), q: c.req.query('q'),
            where: where ? z.array(rowFilterSchema).max(8).parse(JSON.parse(where)) : undefined, hidden: HIDDEN,
        })
        if (result.total > MAX_EXPORT_ROWS || result.rows.length > MAX_EXPORT_ROWS) return c.json({ error: 'Export exceeds 10000 rows. Filter the table and try again.' }, 413)
        const rows = result.rows.map(row => Object.fromEntries(result.columns.map(column => [column, row[column]])))
        const json = c.req.query('format') === 'json'
        const body = json ? JSON.stringify(rows, null, 2) : [result.columns.map(csv).join(','), ...rows.map(row => result.columns.map(column => csv(row[column])).join(','))].join('\n')
        if (Buffer.byteLength(body) > MAX_EXPORT_BYTES) return c.json({ error: 'Export exceeds 5 MB. Filter the table and try again.' }, 413)
        c.header('Content-Type', json ? 'application/json; charset=utf-8' : 'text/csv; charset=utf-8')
        c.header('Content-Disposition', `attachment; filename="data.${json ? 'json' : 'csv'}"; filename*=UTF-8''${encodeURIComponent(name)}.${json ? 'json' : 'csv'}`)
        c.header('Cache-Control', 'no-store')
        c.header('X-Content-Type-Options', 'nosniff')
        return c.body(body)
    })
    app.patch('/tables/:name/rows/:rowid', async c => {
        const db = await client(c)
        const table = c.req.param('name')
        const input = rowUpdateSchema.parse(await c.req.json())
        const columns = await tableColumns(db, table, HIDDEN)
        const entries = Object.entries(input.values)
        if (!entries.length || entries.length > 64) return c.json({ error: 'Choose 1–64 columns to update.' }, 400)
        if (entries.some(([name]) => !columns.some(column => column.name === name))) return c.json({ error: 'Column not found.' }, 400)
        const quote = (name: string) => `"${name.replace(/"/g, '""')}"`
        // RETURNING uses the actual updated row even if its INTEGER PRIMARY KEY changed.
        const result = await db.execute({
            sql: `UPDATE ${quote(table)} SET ${entries.map(([name]) => `${quote(name)} = ?`).join(', ')} WHERE rowid = ? RETURNING rowid AS "__rowid", ${columns.map(column => quote(column.name)).join(', ')}`,
            args: [...entries.map(([, value]) => value), c.req.param('rowid')],
        })
        if (!result.rows.length) return c.json({ error: 'Row not found.' }, 404)
        return c.json({ row: serializeRow(result.columns, result.rows[0]) })
    })
    app.all('/query', c => c.json({ error: 'Raw SQL is unavailable in desktop data routes.' }, 404))
    app.all('/execute', c => c.json({ error: 'Raw SQL is unavailable in desktop data routes.' }, 404))
    app.route('/', createDataRouter(client, HIDDEN))
    return app
}

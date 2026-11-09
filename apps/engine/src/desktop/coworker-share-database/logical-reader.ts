import type { Client, Transaction } from '@libsql/client'
import { DESKTOP_COWORKER_SHARE_DATABASE_COLUMN_TYPES as COLUMN_TYPES, DESKTOP_COWORKER_SHARE_DATABASE_LIMITS as LIMITS, tableViewConfigSchema } from '@rerun/contracts'
import { VIEWS_TABLE, checkViewColumns } from '../../db/tableViews.ts'
import { sqlTokens } from '../sql-guard.ts'
import { captureDesktopCoworkerShareDatabase } from './capture.ts'
import { canonicalJson } from './hash.ts'
import { normalizeTable, type DesktopCoworkerShareDatabaseTableInput, type DesktopCoworkerShareDatabaseViewInput } from './normalize.ts'
import { assertPortableDataName, databaseRefusal, LOGICAL_DATABASE_CAPTURE_LIMITS as BOUNDS, verifyReviewedPrivateDatabase } from './verify.ts'

const quote = (name: string) => `"${name.replace(/"/g, '""')}"`

function assertPlainCreate(sql: string, name: string, columns: { name: string; type: string; pk: boolean; notnull: boolean }[]) {
    const tokens = sqlTokens(sql).filter(token => token.value !== ';').map(token => token.value)
    let index = 0
    const word = (wanted: string) => { if (tokens[index++]?.toUpperCase() !== wanted) return databaseRefusal('Only plain private table schemas are portable.') }
    word('CREATE'); word('TABLE')
    if (tokens[index]?.toUpperCase() === 'IF') { word('IF'); word('NOT'); word('EXISTS') }
    if (tokens[index++] !== name || tokens[index++] !== '(') return databaseRefusal()
    for (const [position, column] of columns.entries()) {
        if (position && tokens[index++] !== ',') return databaseRefusal()
        if (tokens[index++] !== column.name) return databaseRefusal()
        for (const token of column.type ? sqlTokens(column.type) : []) if (tokens[index++]?.toUpperCase() !== token.value.toUpperCase()) return databaseRefusal()
        let pk = false, notnull = false
        while (tokens[index] !== ',' && tokens[index] !== ')' && index < tokens.length) {
            if (tokens[index]?.toUpperCase() === 'PRIMARY' && !pk) { word('PRIMARY'); word('KEY'); pk = true }
            else if (tokens[index]?.toUpperCase() === 'NOT' && !notnull) { word('NOT'); word('NULL'); notnull = true }
            else return databaseRefusal('Defaults, constraints, generated values and executable schemas are not portable in this slice.')
        }
        if (pk !== column.pk || notnull !== column.notnull) return databaseRefusal()
    }
    if (tokens[index++] !== ')' || index !== tokens.length) return databaseRefusal('Extended private table schemas are not supported.')
}

async function columnsOf(tx: Transaction, table: string, internal = false) {
    const result = await tx.execute({ sql: 'SELECT cid,name,type,"notnull",dflt_value,pk,hidden FROM pragma_table_xinfo(?) LIMIT ?', args: [table,LIMITS.maxColumnsPerTable + 1] })
    if (!result.rows.length || result.rows.length > LIMITS.maxColumnsPerTable) return databaseRefusal('Private table column count exceeds its bound.')
    return result.rows.map(row => {
        const name = String(row.name), type = String(row.type)
        if (!internal) assertPortableDataName(name)
        if (!internal && !(COLUMN_TYPES as readonly string[]).includes(type.toUpperCase())) return databaseRefusal('Private column affinity is not supported without a lossless schema mapping.')
        if (Number(row.hidden) !== 0 || row.dflt_value !== null || type.length > 80) return databaseRefusal('Generated columns and defaults are not portable.')
        return { name, type, pk: Number(row.pk) > 0, notnull: Number(row.notnull) > 0 }
    })
}

/** One detached read transaction, bounded before selecting any user cell or saved config. */
export async function captureLogicalPrivateDatabase(client: Client, identity: { workspaceId: number; agentId: string; requestId: string; capturedAt?: string }) {
    const tx = await client.transaction('read')
    try {
        await tx.execute('PRAGMA query_only = ON')
        await tx.execute('PRAGMA trusted_schema = OFF')
        const catalog = await tx.execute({ sql: 'SELECT type,length(name) AS name_size,substr(name,1,257) AS name,length(sql) AS size,substr(sql,1,?) AS ddl FROM sqlite_master LIMIT ?', args: [BOUNDS.maxSchemaSqlChars + 1,BOUNDS.maxSchemaObjects + 1] })
        if (catalog.rows.length > BOUNDS.maxSchemaObjects) return databaseRefusal('Private schema exceeds its object bound.')
        if (catalog.rows.some(row => Number(row.name_size) > 256)) return databaseRefusal('Private schema identifiers exceed their bounds.')
        if (catalog.rows.some(row => row.type === 'view' || row.type === 'trigger' || row.type === 'table' && /\bvirtual\b/i.test(String(row.ddl)))) return databaseRefusal('SQL views, triggers and virtual tables are not portable.')
        const tables: DesktopCoworkerShareDatabaseTableInput[] = []
        const views: DesktopCoworkerShareDatabaseViewInput[] = []
        let totalRows = 0, materializedBytes = 0
        for (const entry of catalog.rows.filter(row => row.type === 'table' && !/^(?:sqlite_|_rerun_)/i.test(String(row.name))).sort((a,b) => String(a.name).localeCompare(String(b.name)))) {
            const name = String(entry.name)
            assertPortableDataName(name)
            if (tables.length >= LIMITS.maxTables || Number(entry.size) > BOUNDS.maxSchemaSqlChars) return databaseRefusal('Private table count or schema size exceeds its bound.')
            const columns = await columnsOf(tx,name)
            assertPlainCreate(String(entry.ddl),name,columns)
            const empty = normalizeTable({ name, columns, rows: [] })
            const indexes = await tx.execute({ sql: 'SELECT "unique",origin FROM pragma_index_list(?) LIMIT ?', args: [name,BOUNDS.maxSchemaObjects + 1] })
            if (indexes.rows.length > BOUNDS.maxSchemaObjects || indexes.rows.some(row => Number(row.unique) && row.origin !== 'pk')) return databaseRefusal('Unique indexes require a separate portable schema implementation.')
            const counted = await tx.execute(`SELECT count(*) AS total FROM (SELECT 1 FROM ${quote(name)} LIMIT ${LIMITS.maxRowsPerTable + 1})`)
            const count = Number(counted.rows[0]!.total)
            totalRows += count
            if (count > LIMITS.maxRowsPerTable || totalRows > LIMITS.maxTotalRows) return databaseRefusal('Private table data exceeds its row bound.')
            const invalid = empty.columns.map(column => {
                const field = quote(column.name)
                return column.type === 'BLOB'
                    ? `(typeof(${field}) NOT IN ('null','blob') OR length(${field}) > ${LIMITS.maxBlobBytes})`
                    : `(typeof(${field}) = 'blob' OR typeof(${field}) = 'text' AND length(${field}) > ${LIMITS.maxStringValueChars} OR typeof(${field}) = 'integer' AND (${field} > 9007199254740991 OR ${field} < -9007199254740991))`
            }).join(' OR ')
            if ((await tx.execute(`SELECT 1 FROM ${quote(name)} WHERE ${invalid} LIMIT 1`)).rows.length) return databaseRefusal('Private cells exceed portable value bounds.')
            const rows: Record<string, unknown>[] = []
            const fields = columns.map(column => quote(column.name)).join(',')
            for (let offset = 0; offset < count; offset += BOUNDS.batchRows) {
                const batch = await tx.execute(`SELECT ${fields} FROM ${quote(name)} ORDER BY ${fields} LIMIT ${BOUNDS.batchRows} OFFSET ${offset}`)
                for (const row of batch.rows) {
                    const record = Object.fromEntries(columns.map(column => [column.name,row[column.name] instanceof ArrayBuffer ? new Uint8Array(row[column.name] as ArrayBuffer) : row[column.name]]))
                    const normalized = normalizeTable({ name, columns, rows: [record] }).rows[0]!
                    materializedBytes += Buffer.byteLength(canonicalJson(normalized))
                    if (materializedBytes > LIMITS.maxTotalBytes) return databaseRefusal('Private data exceeds its byte bound.')
                    rows.push(record)
                }
            }
            tables.push({ name, columns, rows })
        }
        if (catalog.rows.some(row => String(row.name).toLowerCase() === VIEWS_TABLE && row.name !== VIEWS_TABLE)) return databaseRefusal('Saved view storage uses an unsupported identity alias.')
        if (catalog.rows.some(row => row.name === VIEWS_TABLE)) {
            const columns = await columnsOf(tx,VIEWS_TABLE,true)
            if (columns.map(column => column.name).join(',') !== 'id,table_name,name,position,config,updated_at') return databaseRefusal('Saved view storage schema is unavailable.')
            const count = await tx.execute(`SELECT count(*) AS total FROM (SELECT 1 FROM ${VIEWS_TABLE} LIMIT ${LIMITS.maxViews + 1})`)
            if (Number(count.rows[0]!.total) > LIMITS.maxViews) return databaseRefusal('Too many saved private views.')
            const bad = await tx.execute(`SELECT 1 FROM ${VIEWS_TABLE} WHERE typeof(id) != 'text' OR length(id) > 80 OR typeof(table_name) != 'text' OR length(table_name) > 64 OR typeof(name) != 'text' OR length(name) > 60 OR typeof(position) != 'integer' OR position < 0 OR position > 10000 OR typeof(config) != 'text' OR length(CAST(config AS BLOB)) > ${BOUNDS.maxViewConfigBytes} LIMIT 1`)
            if (bad.rows.length) return databaseRefusal('Saved private view metadata exceeds its bounds.')
            const saved = await tx.execute(`SELECT id,table_name,name,position,config FROM ${VIEWS_TABLE} ORDER BY table_name,position,name,id LIMIT ${LIMITS.maxViews + 1}`)
            for (const row of saved.rows) {
                if (!String(row.id).trim() || String(row.id) !== String(row.id).trim() || !String(row.name).trim() || String(row.name) !== String(row.name).trim()) return databaseRefusal('Saved view identity would be silently normalized.')
                const table = tables.find(candidate => candidate.name === row.table_name)
                if (!table) return databaseRefusal('Saved view points outside captured private tables.')
                const raw = JSON.parse(String(row.config)), config = tableViewConfigSchema.parse(raw)
                if (canonicalJson(raw) !== canonicalJson(config)) return databaseRefusal('Saved view would be silently sanitized.')
                checkViewColumns(table.name,table.columns.map(column => column.name),config)
                views.push({ id: String(row.id), table: table.name, name: String(row.name), position: Number(row.position), config })
            }
        }
        const pkg = await captureDesktopCoworkerShareDatabase({ workspaceId: identity.workspaceId, agentId: identity.agentId, listPrivateSnapshot: async () => ({ tables,views }) }, { requestId: identity.requestId, includeDatabase: true, capturedAt: identity.capturedAt })
        if ('unavailable' in pkg) return databaseRefusal()
        return verifyReviewedPrivateDatabase(pkg,{ sourceWorkspaceId: identity.workspaceId, sourceAgentId: identity.agentId, captureRequestId: identity.requestId, expectedDigest: pkg.digest })
    } finally { try { await tx.rollback() } finally { tx.close() } }
}

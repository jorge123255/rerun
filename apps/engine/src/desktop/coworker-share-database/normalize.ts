import {
    DESKTOP_COWORKER_SHARE_DATABASE_COLUMN_TYPES,
    DESKTOP_COWORKER_SHARE_DATABASE_LIMITS,
    desktopCoworkerShareDatabaseColumnSchema,
    desktopCoworkerShareDatabaseIdentifierSchema,
    desktopCoworkerShareDatabaseRowSchema,
    desktopCoworkerShareDatabaseTableSchema,
    desktopCoworkerShareDatabaseViewSchema,
    type DesktopCoworkerShareDatabaseColumn,
    type DesktopCoworkerShareDatabaseRow,
    type DesktopCoworkerShareDatabaseTable,
    type DesktopCoworkerShareDatabaseValue,
    type DesktopCoworkerShareDatabaseView,
} from '@rerun/contracts'
import { tableViewConfigSchema } from '@rerun/contracts'
import { DesktopCoworkerShareDatabaseError } from './errors.ts'
import { canonicalJson, sha256Hex } from './hash.ts'

const ALLOWED_TYPES = new Set<string>(DESKTOP_COWORKER_SHARE_DATABASE_COLUMN_TYPES)

export type DesktopCoworkerShareDatabaseColumnInput = {
    name: string
    type: string
    pk: boolean
    notnull: boolean
}

export type DesktopCoworkerShareDatabaseTableInput = {
    name: string
    columns: readonly DesktopCoworkerShareDatabaseColumnInput[]
    rows: readonly Record<string, unknown>[]
}

export type DesktopCoworkerShareDatabaseViewInput = {
    id: string
    table: string
    name: string
    position: number
    config: unknown
}

function assertSafeIdentifier(name: string, kind: 'table' | 'column'): string {
    const parsed = desktopCoworkerShareDatabaseIdentifierSchema.safeParse(name)
    if (!parsed.success) {
        throw new DesktopCoworkerShareDatabaseError('invalid', `Unsupported ${kind} name in portable database transfer.`)
    }
    const lower = parsed.data.toLowerCase()
    if (lower.startsWith('sqlite_') || lower.startsWith('_rerun_') || lower.startsWith('.rerun') || lower.includes('..')) {
        throw new DesktopCoworkerShareDatabaseError('invalid', `Internal ${kind} names cannot be transferred.`)
    }
    return parsed.data
}

function normalizeType(raw: string): DesktopCoworkerShareDatabaseColumn['type'] {
    const base = raw.trim().toUpperCase().replace(/\s*\(.*\)$/, '')
    let mapped = base
    if (base === '' || base === 'VARCHAR' || base === 'CHAR' || base === 'CLOB' || base === 'DATE' || base === 'DATETIME') mapped = 'TEXT'
    else if (base === 'INT' || base === 'BIGINT' || base === 'SMALLINT') mapped = 'INTEGER'
    else if (base === 'DOUBLE' || base === 'FLOAT') mapped = 'REAL'
    else if (base === 'BOOL') mapped = 'BOOLEAN'
    if (!ALLOWED_TYPES.has(mapped)) {
        throw new DesktopCoworkerShareDatabaseError('invalid', `Unsupported column type "${raw}" in portable database transfer.`)
    }
    return mapped as DesktopCoworkerShareDatabaseColumn['type']
}

function normalizeValue(value: unknown, type: DesktopCoworkerShareDatabaseColumn['type']): DesktopCoworkerShareDatabaseValue {
    if (value === undefined) throw new DesktopCoworkerShareDatabaseError('invalid', 'Undefined cell values are not portable.')
    if (value === null) return null
    if (type === 'BLOB') {
        if (typeof value === 'object' && value && 'encoding' in value) {
            const blob = value as { encoding: string; bytes: number; data: string }
            if (blob.encoding !== 'base64' || typeof blob.data !== 'string' || typeof blob.bytes !== 'number') {
                throw new DesktopCoworkerShareDatabaseError('invalid', 'BLOB values must use bounded base64 encoding.')
            }
            if (blob.bytes > DESKTOP_COWORKER_SHARE_DATABASE_LIMITS.maxBlobBytes || Buffer.byteLength(blob.data, 'utf8') > DESKTOP_COWORKER_SHARE_DATABASE_LIMITS.maxBlobBytes * 2) {
                throw new DesktopCoworkerShareDatabaseError('bounds', 'A BLOB value exceeds the portable size limit.')
            }
            // Reject anything that looks like SQL text disguised as blob metadata abuse is still data-only.
            return { encoding: 'base64', bytes: blob.bytes, data: blob.data }
        }
        if (typeof Buffer !== 'undefined' && Buffer.isBuffer(value)) {
            if (value.byteLength > DESKTOP_COWORKER_SHARE_DATABASE_LIMITS.maxBlobBytes) {
                throw new DesktopCoworkerShareDatabaseError('bounds', 'A BLOB value exceeds the portable size limit.')
            }
            return { encoding: 'base64', bytes: value.byteLength, data: value.toString('base64') }
        }
        if (value instanceof Uint8Array) {
            if (value.byteLength > DESKTOP_COWORKER_SHARE_DATABASE_LIMITS.maxBlobBytes) {
                throw new DesktopCoworkerShareDatabaseError('bounds', 'A BLOB value exceeds the portable size limit.')
            }
            return { encoding: 'base64', bytes: value.byteLength, data: Buffer.from(value).toString('base64') }
        }
        throw new DesktopCoworkerShareDatabaseError('invalid', 'BLOB columns require base64 payload values.')
    }
    if (typeof value === 'string') {
        if (value.length > DESKTOP_COWORKER_SHARE_DATABASE_LIMITS.maxStringValueChars) {
            throw new DesktopCoworkerShareDatabaseError('bounds', 'A text cell exceeds the portable size limit.')
        }
        // Never treat cell text as SQL to execute.
        return value
    }
    if (typeof value === 'number') {
        if (!Number.isFinite(value)) throw new DesktopCoworkerShareDatabaseError('invalid', 'Non-finite numbers are not portable.')
        return value
    }
    if (typeof value === 'boolean') return value
    throw new DesktopCoworkerShareDatabaseError('invalid', 'Unsupported cell value in portable database transfer.')
}

export function digestTable(table: Omit<DesktopCoworkerShareDatabaseTable, 'tableDigest'>): string {
    return sha256Hex(canonicalJson({
        name: table.name,
        columns: table.columns,
        rows: table.rows,
    }))
}

export function digestView(view: Omit<DesktopCoworkerShareDatabaseView, 'viewDigest'>): string {
    return sha256Hex(canonicalJson({
        id: view.id,
        table: view.table,
        name: view.name,
        position: view.position,
        config: view.config,
    }))
}

export function normalizeTable(input: DesktopCoworkerShareDatabaseTableInput): DesktopCoworkerShareDatabaseTable {
    const name = assertSafeIdentifier(input.name, 'table')
    if (input.columns.length < 1 || input.columns.length > DESKTOP_COWORKER_SHARE_DATABASE_LIMITS.maxColumnsPerTable) {
        throw new DesktopCoworkerShareDatabaseError('bounds', 'A portable table has an unsupported column count.')
    }
    if (input.rows.length > DESKTOP_COWORKER_SHARE_DATABASE_LIMITS.maxRowsPerTable) {
        throw new DesktopCoworkerShareDatabaseError('bounds', 'A portable table exceeds the row limit.')
    }
    const columns: DesktopCoworkerShareDatabaseColumn[] = []
    const seenColumns = new Set<string>()
    for (const column of input.columns) {
        const columnName = assertSafeIdentifier(column.name, 'column')
        if (seenColumns.has(columnName.toLowerCase())) {
            throw new DesktopCoworkerShareDatabaseError('invalid', 'Duplicate column names are not portable.')
        }
        seenColumns.add(columnName.toLowerCase())
        columns.push(desktopCoworkerShareDatabaseColumnSchema.parse({
            name: columnName,
            type: normalizeType(column.type),
            pk: !!column.pk,
            notnull: !!column.notnull,
        }))
    }
    const columnByName = new Map(columns.map(column => [column.name, column]))
    const rows: DesktopCoworkerShareDatabaseRow[] = []
    for (const raw of input.rows) {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
            throw new DesktopCoworkerShareDatabaseError('invalid', 'Table rows must be plain objects.')
        }
        // Reject smuggled executable SQL fields.
        for (const key of Object.keys(raw)) {
            if (key.toLowerCase() === 'sql' || key.toLowerCase() === '__sql' || key.toLowerCase() === 'statements') {
                throw new DesktopCoworkerShareDatabaseError('invalid', 'Executable SQL content is not accepted in a portable database transfer.')
            }
        }
        const row: Record<string, DesktopCoworkerShareDatabaseValue> = {}
        for (const [key, value] of Object.entries(raw)) {
            const column = columnByName.get(key)
            if (!column) throw new DesktopCoworkerShareDatabaseError('invalid', `Row references unknown column "${key}".`)
            row[column.name] = normalizeValue(value, column.type)
        }
        for (const column of columns) {
            if (column.notnull && !(column.name in row)) {
                throw new DesktopCoworkerShareDatabaseError('invalid', `Missing NOT NULL column "${column.name}".`)
            }
            if (column.notnull && row[column.name] === null) {
                throw new DesktopCoworkerShareDatabaseError('invalid', `NULL is not allowed in NOT NULL column "${column.name}".`)
            }
            if (!(column.name in row)) row[column.name] = null
        }
        rows.push(desktopCoworkerShareDatabaseRowSchema.parse(row))
    }
    const withoutDigest = { name, columns, rows }
    return desktopCoworkerShareDatabaseTableSchema.parse({
        ...withoutDigest,
        tableDigest: digestTable(withoutDigest),
    })
}

export function normalizeView(input: DesktopCoworkerShareDatabaseViewInput, tableNames: ReadonlySet<string>): DesktopCoworkerShareDatabaseView {
    const table = assertSafeIdentifier(input.table, 'table')
    if (!tableNames.has(table)) {
        throw new DesktopCoworkerShareDatabaseError('invalid', 'A saved view references a table that is not in the portable package.')
    }
    if (typeof input.id !== 'string' || !input.id.trim() || input.id.length > 80) {
        throw new DesktopCoworkerShareDatabaseError('invalid', 'Saved view id is missing or too long.')
    }
    if (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 60) {
        throw new DesktopCoworkerShareDatabaseError('invalid', 'Saved view name is missing or too long.')
    }
    const config = tableViewConfigSchema.parse(input.config)
    const withoutDigest = {
        id: input.id.trim(),
        table,
        name: input.name.trim(),
        position: Number.isFinite(input.position) ? Math.max(0, Math.floor(input.position)) : 0,
        config,
    }
    return desktopCoworkerShareDatabaseViewSchema.parse({
        ...withoutDigest,
        viewDigest: digestView(withoutDigest),
    })
}

export function packageDigest(tables: readonly DesktopCoworkerShareDatabaseTable[], views: readonly DesktopCoworkerShareDatabaseView[]): string {
    const orderedTables = [...tables].sort((a, b) => a.name.localeCompare(b.name))
    const orderedViews = [...views].sort((a, b) => a.table.localeCompare(b.table) || a.position - b.position || a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
    return sha256Hex(canonicalJson({
        tables: orderedTables.map(table => [table.name, table.tableDigest]),
        views: orderedViews.map(view => [view.id, view.viewDigest]),
    }))
}

export function measurePackage(tables: readonly DesktopCoworkerShareDatabaseTable[], views: readonly DesktopCoworkerShareDatabaseView[]): { count: number; bytes: number } {
    const bytes = Buffer.byteLength(canonicalJson({ tables, views }), 'utf8')
    return { count: tables.length, bytes }
}

/** Build CREATE TABLE column DDL from allowlisted types only — never from archive SQL text. */
export function logicalCreateTableSql(table: DesktopCoworkerShareDatabaseTable): string {
    const cols = table.columns.map(column => {
        const pieces = [`"${column.name.replace(/"/g, '""')}" ${column.type}`]
        if (column.pk) pieces.push('PRIMARY KEY')
        if (column.notnull && !column.pk) pieces.push('NOT NULL')
        return pieces.join(' ')
    })
    return `CREATE TABLE IF NOT EXISTS "${table.name.replace(/"/g, '""')}" (${cols.join(', ')})`
}

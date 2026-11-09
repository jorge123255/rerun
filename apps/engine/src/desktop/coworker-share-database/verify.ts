import { DESKTOP_COWORKER_SHARE_DATABASE_LIMITS as LIMITS, desktopCoworkerShareDatabasePackageSchema, scanPathForSecrets, scanTextForSecrets, type DesktopCoworkerShareDatabasePackage } from '@rerun/contracts'
import { checkViewColumns } from '../../db/tableViews.ts'
import { canonicalJson } from './hash.ts'
import { measurePackage, normalizeTable, normalizeView, packageDigest } from './normalize.ts'
import { DesktopCoworkerShareDatabaseError } from './errors.ts'

export const LOGICAL_DATABASE_CAPTURE_LIMITS = {
    maxSourceBytes: 128 * 1024 * 1024,
    maxSchemaObjects: 256,
    maxSchemaSqlChars: 20_000,
    maxViewConfigBytes: 32 * 1024,
    maxEnvelopeBytes: LIMITS.maxTotalBytes + 64 * 1024,
    deadlineMs: 10_000,
    batchRows: 4,
} as const

export function databaseRefusal(message = 'The private database cannot be safely captured or verified.'): never {
    throw new DesktopCoworkerShareDatabaseError('invalid', message)
}

export function assertPortableDataName(name: string) {
    if (['__proto__', 'prototype', 'constructor'].includes(name.toLowerCase()) || /^(?:sqlite_|_rerun_)/i.test(name) || scanPathForSecrets(name).length || /(?:^|_)(?:api_keys?|tokens?|secrets?|grants?|sessions?|chats?|messages|history|runs?|memories|tool_calls|connections?|providers?|oauth|credentials?)(?:_|$)/i.test(name)) databaseRefusal('Private system or credential fields cannot be transferred.')
}

export type DatabaseVerificationIdentity = {
    sourceWorkspaceId: number
    sourceAgentId: string
    captureRequestId: string
    expectedDigest: string
}

/** Verify logical content before any destination authority or write is invoked. */
export function verifyReviewedPrivateDatabase(raw: unknown, identity: DatabaseVerificationIdentity): DesktopCoworkerShareDatabasePackage {
    let encoded: string | undefined
    try { encoded = JSON.stringify(raw) } catch { return databaseRefusal() }
    if (!encoded || Buffer.byteLength(encoded) > LOGICAL_DATABASE_CAPTURE_LIMITS.maxEnvelopeBytes) return databaseRefusal('Private database package exceeds its byte bound.')
    const pkg = desktopCoworkerShareDatabasePackageSchema.parse(raw)
    if (canonicalJson(raw) !== canonicalJson(pkg)) return databaseRefusal('Private database metadata would be silently changed by validation.')
    if (pkg.sourceWorkspaceId !== identity.sourceWorkspaceId || pkg.sourceAgentId !== identity.sourceAgentId || pkg.captureRequestId !== identity.captureRequestId || pkg.digest !== identity.expectedDigest) throw new DesktopCoworkerShareDatabaseError('stale', 'Private database review belongs to another source or attempt.')
    const names = new Set<string>()
    let rows = 0
    for (const table of pkg.tables) {
        assertPortableDataName(table.name)
        if (names.has(table.name.toLowerCase())) return databaseRefusal('Duplicate private table identity.')
        names.add(table.name.toLowerCase())
        if (table.columns.filter(column => column.pk).length > 1) return databaseRefusal('Composite primary keys require a separate portable schema implementation.')
        if (table.columns.some(column => column.pk && column.notnull && column.type !== 'INTEGER')) return databaseRefusal('This primary key requires a lossless install schema mapping before transfer.')
        for (const column of table.columns) assertPortableDataName(column.name)
        for (const row of table.rows) for (const column of table.columns) {
            const value = row[column.name]
            if (column.pk && column.type === 'INTEGER' && (typeof value !== 'number' || !Number.isSafeInteger(value))) return databaseRefusal('Integer primary keys must preserve exact explicit row identities.')
            if (column.type === 'TEXT' && value !== null && typeof value !== 'string') return databaseRefusal('Text cells must preserve their SQLite storage values.')
            if (column.type !== 'TEXT' && column.type !== 'BLOB' && typeof value === 'string' && /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value.trim())) return databaseRefusal('Ambiguous numeric text requires a lossless affinity mapping before transfer.')
        }
        for (const row of table.rows) for (const value of Object.values(row)) {
            if (typeof value === 'string' && scanTextForSecrets(value).length) return databaseRefusal('Private data is flagged as containing credentials.')
            if (value && typeof value === 'object') {
                const decoded = Buffer.from(value.data, 'base64')
                if (decoded.length !== value.bytes || decoded.toString('base64') !== value.data) return databaseRefusal('A private BLOB has inconsistent bytes or encoding.')
                if (scanTextForSecrets(decoded.toString('utf8')).length) return databaseRefusal('Private data is flagged as containing credentials.')
            }
        }
        const normalized = normalizeTable(table)
        if (canonicalJson(normalized) !== canonicalJson(table)) return databaseRefusal('Private table bytes or digest differ from the reviewed schema/data.')
        const primary = table.columns.find(column => column.pk)
        if (primary) {
            const keys = new Set<string>()
            for (const row of table.rows) {
                const key = row[primary.name]
                if (key === null) continue
                const encoded = canonicalJson(key)
                if (keys.has(encoded)) return databaseRefusal('Duplicate primary key data is not portable.')
                keys.add(encoded)
            }
        }
        rows += table.rows.length
    }
    if (rows > LIMITS.maxTotalRows) return databaseRefusal('Private database exceeds its total row bound.')
    const viewIds = new Set<string>(), viewNames = new Set<string>()
    for (const view of pkg.views) {
        const table = pkg.tables.find(candidate => candidate.name === view.table)
        if (!table || viewIds.has(view.id) || viewNames.has(`${view.table}\0${view.name}`)) return databaseRefusal('Saved view identity is duplicate or outside the private snapshot.')
        viewIds.add(view.id); viewNames.add(`${view.table}\0${view.name}`)
        if (Buffer.byteLength(canonicalJson(view.config)) > LOGICAL_DATABASE_CAPTURE_LIMITS.maxViewConfigBytes || scanTextForSecrets(canonicalJson(view)).length) return databaseRefusal('Saved view metadata exceeds its bound or is flagged as containing credentials.')
        checkViewColumns(view.table, table.columns.map(column => column.name), view.config)
        for (const column of Object.keys(view.config.tones ?? {})) if (!table.columns.some(candidate => candidate.name === column)) return databaseRefusal('Saved view tone references an unknown column.')
        if (canonicalJson(normalizeView(view, new Set(pkg.tables.map(candidate => candidate.name)))) !== canonicalJson(view)) return databaseRefusal('Saved view bytes or digest differ from the reviewed view.')
    }
    const contents = measurePackage(pkg.tables, pkg.views)
    if (contents.bytes > LIMITS.maxTotalBytes || canonicalJson(contents) !== canonicalJson(pkg.contents) || packageDigest(pkg.tables, pkg.views) !== pkg.digest) return databaseRefusal('Private database review counts or digest do not match its contents.')
    return pkg
}

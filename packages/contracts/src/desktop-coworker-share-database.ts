import { z } from 'zod'
import { tableViewConfigSchema } from './table-view.js'

/** Logical private-database transfer. Coordinates with A (memories) and E (share UI). Never embeds live SQLite bytes or executable SQL. */
export const DESKTOP_COWORKER_SHARE_DATABASE_FORMAT = 'desktop-coworker-share-database' as const
export const DESKTOP_COWORKER_SHARE_DATABASE_FORMAT_VERSION = 1 as const

export const DESKTOP_COWORKER_SHARE_DATABASE_LIMITS = {
    maxTables: 64,
    maxColumnsPerTable: 64,
    maxRowsPerTable: 5_000,
    maxTotalRows: 20_000,
    maxViews: 256,
    maxIdentifierLength: 64,
    maxStringValueChars: 8_192,
    maxBlobBytes: 64 * 1024,
    maxTotalBytes: 16 * 1024 * 1024,
    maxRequestIdLength: 160,
} as const

/** SQLite type names accepted in a portable logical schema (case-insensitive; stored uppercased). */
export const DESKTOP_COWORKER_SHARE_DATABASE_COLUMN_TYPES = [
    'INTEGER',
    'REAL',
    'TEXT',
    'NUMERIC',
    'BOOLEAN',
    'BLOB',
] as const

export const desktopCoworkerShareDatabaseIdentifierSchema = z
    .string()
    .min(1)
    .max(DESKTOP_COWORKER_SHARE_DATABASE_LIMITS.maxIdentifierLength)
    .regex(/^[A-Za-z_][A-Za-z0-9_]*$/)
    .refine(name => !name.toLowerCase().startsWith('sqlite_') && !name.toLowerCase().startsWith('_rerun_'), {
        message: 'Internal table or column names cannot be transferred',
    })

export const desktopCoworkerShareDatabaseColumnTypeSchema = z
    .string()
    .trim()
    .transform(value => value.toUpperCase())
    .pipe(z.enum(DESKTOP_COWORKER_SHARE_DATABASE_COLUMN_TYPES))

export const desktopCoworkerShareDatabaseColumnSchema = z.strictObject({
    name: desktopCoworkerShareDatabaseIdentifierSchema,
    type: desktopCoworkerShareDatabaseColumnTypeSchema,
    pk: z.boolean(),
    notnull: z.boolean(),
})
export type DesktopCoworkerShareDatabaseColumn = z.infer<typeof desktopCoworkerShareDatabaseColumnSchema>

const scalarSchema = z.union([
    z.string().max(DESKTOP_COWORKER_SHARE_DATABASE_LIMITS.maxStringValueChars),
    z.number().finite(),
    z.boolean(),
    z.null(),
])

/** BLOB values travel as bounded base64; never as executable SQL. */
export const desktopCoworkerShareDatabaseValueSchema = z.union([
    scalarSchema,
    z.strictObject({
        encoding: z.literal('base64'),
        bytes: z.number().int().nonnegative().max(DESKTOP_COWORKER_SHARE_DATABASE_LIMITS.maxBlobBytes),
        data: z.string().regex(/^[A-Za-z0-9+/=]*$/).max(Math.ceil(DESKTOP_COWORKER_SHARE_DATABASE_LIMITS.maxBlobBytes * 4 / 3) + 4),
    }),
])
export type DesktopCoworkerShareDatabaseValue = z.infer<typeof desktopCoworkerShareDatabaseValueSchema>

export const desktopCoworkerShareDatabaseRowSchema = z.record(
    desktopCoworkerShareDatabaseIdentifierSchema,
    desktopCoworkerShareDatabaseValueSchema,
)
export type DesktopCoworkerShareDatabaseRow = z.infer<typeof desktopCoworkerShareDatabaseRowSchema>

export const desktopCoworkerShareDatabaseTableSchema = z.strictObject({
    name: desktopCoworkerShareDatabaseIdentifierSchema,
    columns: z.array(desktopCoworkerShareDatabaseColumnSchema).min(1).max(DESKTOP_COWORKER_SHARE_DATABASE_LIMITS.maxColumnsPerTable),
    rows: z.array(desktopCoworkerShareDatabaseRowSchema).max(DESKTOP_COWORKER_SHARE_DATABASE_LIMITS.maxRowsPerTable),
    tableDigest: z.string().regex(/^[a-f0-9]{64}$/),
})
export type DesktopCoworkerShareDatabaseTable = z.infer<typeof desktopCoworkerShareDatabaseTableSchema>

export const desktopCoworkerShareDatabaseViewSchema = z.strictObject({
    id: z.string().min(1).max(80),
    table: desktopCoworkerShareDatabaseIdentifierSchema,
    name: z.string().trim().min(1).max(60),
    position: z.number().int().nonnegative().max(10_000),
    config: tableViewConfigSchema,
    viewDigest: z.string().regex(/^[a-f0-9]{64}$/),
})
export type DesktopCoworkerShareDatabaseView = z.infer<typeof desktopCoworkerShareDatabaseViewSchema>

export const desktopCoworkerShareDatabaseBucketSchema = z.strictObject({
    count: z.number().int().nonnegative().max(DESKTOP_COWORKER_SHARE_DATABASE_LIMITS.maxTables),
    bytes: z.number().int().nonnegative().max(DESKTOP_COWORKER_SHARE_DATABASE_LIMITS.maxTotalBytes),
})
export type DesktopCoworkerShareDatabaseBucket = z.infer<typeof desktopCoworkerShareDatabaseBucketSchema>

export const desktopCoworkerShareDatabasePackageSchema = z.strictObject({
    format: z.literal(DESKTOP_COWORKER_SHARE_DATABASE_FORMAT),
    formatVersion: z.literal(DESKTOP_COWORKER_SHARE_DATABASE_FORMAT_VERSION),
    sourceWorkspaceId: z.number().int().positive(),
    sourceAgentId: z.string().min(1).max(160),
    captureRequestId: z.string().min(1).max(DESKTOP_COWORKER_SHARE_DATABASE_LIMITS.maxRequestIdLength),
    capturedAt: z.string().min(1).max(64),
    tables: z.array(desktopCoworkerShareDatabaseTableSchema).max(DESKTOP_COWORKER_SHARE_DATABASE_LIMITS.maxTables),
    views: z.array(desktopCoworkerShareDatabaseViewSchema).max(DESKTOP_COWORKER_SHARE_DATABASE_LIMITS.maxViews),
    contents: desktopCoworkerShareDatabaseBucketSchema,
    digest: z.string().regex(/^[a-f0-9]{64}$/),
})
export type DesktopCoworkerShareDatabasePackage = z.infer<typeof desktopCoworkerShareDatabasePackageSchema>

export const desktopCoworkerShareDatabasePreviewSchema = z.strictObject({
    available: z.boolean(),
    reason: z.string().max(400).optional(),
    contents: desktopCoworkerShareDatabaseBucketSchema,
    viewCount: z.number().int().nonnegative().max(DESKTOP_COWORKER_SHARE_DATABASE_LIMITS.maxViews),
    digest: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
})
export type DesktopCoworkerShareDatabasePreview = z.infer<typeof desktopCoworkerShareDatabasePreviewSchema>

export const desktopCoworkerShareDatabaseRestoreResultSchema = z.strictObject({
    status: z.enum(['installed', 'reused', 'partial', 'uncertain', 'unavailable']),
    captureRequestId: z.string().min(1).max(DESKTOP_COWORKER_SHARE_DATABASE_LIMITS.maxRequestIdLength),
    packageDigest: z.string().regex(/^[a-f0-9]{64}$/),
    destinationAgentId: z.string().min(1).max(160),
    installedTables: z.array(z.string()).max(DESKTOP_COWORKER_SHARE_DATABASE_LIMITS.maxTables),
    reusedTables: z.array(z.string()).max(DESKTOP_COWORKER_SHARE_DATABASE_LIMITS.maxTables),
    installedViews: z.number().int().nonnegative(),
    reusedViews: z.number().int().nonnegative(),
    reason: z.string().max(400).optional(),
})
export type DesktopCoworkerShareDatabaseRestoreResult = z.infer<typeof desktopCoworkerShareDatabaseRestoreResultSchema>

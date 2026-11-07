import {
    DESKTOP_COWORKER_SHARE_DATABASE_FORMAT,
    DESKTOP_COWORKER_SHARE_DATABASE_FORMAT_VERSION,
    DESKTOP_COWORKER_SHARE_DATABASE_LIMITS,
    desktopCoworkerShareDatabasePackageSchema,
    type DesktopCoworkerShareDatabasePackage,
    type DesktopCoworkerShareDatabaseTable,
    type DesktopCoworkerShareDatabaseView,
} from '@rerun/contracts'
import { DesktopCoworkerShareDatabaseError } from './errors.ts'
import {
    measurePackage,
    normalizeTable,
    normalizeView,
    packageDigest,
    type DesktopCoworkerShareDatabaseTableInput,
    type DesktopCoworkerShareDatabaseViewInput,
} from './normalize.ts'

export type DesktopCoworkerShareDatabaseCaptureAuthority = {
    workspaceId: number
    agentId: string
    /** Observational read of this coworker's private user tables + saved views only. */
    listPrivateSnapshot: () => Promise<{
        tables: readonly DesktopCoworkerShareDatabaseTableInput[]
        views: readonly DesktopCoworkerShareDatabaseViewInput[]
    }>
}

export type DesktopCoworkerShareDatabaseCaptureInput = {
    requestId: string
    includeDatabase: boolean
    capturedAt?: string
}

export async function captureDesktopCoworkerShareDatabase(
    authority: DesktopCoworkerShareDatabaseCaptureAuthority | null | undefined,
    input: DesktopCoworkerShareDatabaseCaptureInput,
): Promise<DesktopCoworkerShareDatabasePackage | { unavailable: true; reason: string }> {
    if (!input.includeDatabase) {
        return { unavailable: true, reason: 'Coworker database was not selected for this share.' }
    }
    if (!authority) {
        return { unavailable: true, reason: 'Database transfer is unavailable until the canonical private-database authority is bound.' }
    }
    if (!input.requestId || input.requestId.length > DESKTOP_COWORKER_SHARE_DATABASE_LIMITS.maxRequestIdLength) {
        throw new DesktopCoworkerShareDatabaseError('invalid', 'Capture request id is missing or too long.')
    }
    const snapshot = await authority.listPrivateSnapshot()
    if (snapshot.tables.length > DESKTOP_COWORKER_SHARE_DATABASE_LIMITS.maxTables) {
        throw new DesktopCoworkerShareDatabaseError('bounds', 'Too many private tables for a portable share.')
    }
    const tables: DesktopCoworkerShareDatabaseTable[] = []
    const seen = new Set<string>()
    let totalRows = 0
    for (const inputTable of snapshot.tables) {
        const table = normalizeTable(inputTable)
        if (seen.has(table.name.toLowerCase())) throw new DesktopCoworkerShareDatabaseError('invalid', 'Duplicate table names are not portable.')
        seen.add(table.name.toLowerCase())
        totalRows += table.rows.length
        tables.push(table)
    }
    tables.sort((a, b) => a.name.localeCompare(b.name))
    if (totalRows > DESKTOP_COWORKER_SHARE_DATABASE_LIMITS.maxTotalRows) {
        throw new DesktopCoworkerShareDatabaseError('bounds', 'Private tables exceed the portable total row limit.')
    }
    const tableNames = new Set(tables.map(table => table.name))
    const views: DesktopCoworkerShareDatabaseView[] = []
    const viewIds = new Set<string>()
    for (const inputView of snapshot.views) {
        const view = normalizeView(inputView, tableNames)
        if (viewIds.has(view.id)) throw new DesktopCoworkerShareDatabaseError('invalid', 'Duplicate saved view ids are not portable.')
        viewIds.add(view.id)
        views.push(view)
    }
    views.sort((a, b) => a.table.localeCompare(b.table) || a.position - b.position || a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
    if (views.length > DESKTOP_COWORKER_SHARE_DATABASE_LIMITS.maxViews) {
        throw new DesktopCoworkerShareDatabaseError('bounds', 'Too many saved views for a portable share.')
    }
    const contents = measurePackage(tables, views)
    if (contents.bytes > DESKTOP_COWORKER_SHARE_DATABASE_LIMITS.maxTotalBytes) {
        throw new DesktopCoworkerShareDatabaseError('bounds', 'Private database content exceeds the portable total size limit.')
    }
    return desktopCoworkerShareDatabasePackageSchema.parse({
        format: DESKTOP_COWORKER_SHARE_DATABASE_FORMAT,
        formatVersion: DESKTOP_COWORKER_SHARE_DATABASE_FORMAT_VERSION,
        sourceWorkspaceId: authority.workspaceId,
        sourceAgentId: authority.agentId,
        captureRequestId: input.requestId,
        capturedAt: input.capturedAt ?? new Date().toISOString(),
        tables,
        views,
        contents,
        digest: packageDigest(tables, views),
    })
}

import {
    desktopCoworkerShareDatabasePreviewSchema,
    type DesktopCoworkerShareDatabasePreview,
    type DesktopCoworkerShareDatabaseTable,
    type DesktopCoworkerShareDatabaseView,
} from '@rerun/contracts'
import { measurePackage, normalizeTable, normalizeView, packageDigest, type DesktopCoworkerShareDatabaseTableInput, type DesktopCoworkerShareDatabaseViewInput } from './normalize.ts'
import { DesktopCoworkerShareDatabaseError } from './errors.ts'
import { DESKTOP_COWORKER_SHARE_DATABASE_LIMITS } from '@rerun/contracts'

export function previewDesktopCoworkerShareDatabase(
    tablesInput: readonly DesktopCoworkerShareDatabaseTableInput[],
    viewsInput: readonly DesktopCoworkerShareDatabaseViewInput[] = [],
    options?: { available?: boolean; reason?: string },
): DesktopCoworkerShareDatabasePreview {
    if (options?.available === false) {
        return desktopCoworkerShareDatabasePreviewSchema.parse({
            available: false,
            reason: options.reason ?? 'Database transfer is unavailable.',
            contents: { count: 0, bytes: 0 },
            viewCount: 0,
            digest: null,
        })
    }
    if (tablesInput.length > DESKTOP_COWORKER_SHARE_DATABASE_LIMITS.maxTables) {
        throw new DesktopCoworkerShareDatabaseError('bounds', 'Too many private tables for a portable share.')
    }
    const tables: DesktopCoworkerShareDatabaseTable[] = []
    const seen = new Set<string>()
    let totalRows = 0
    for (const input of tablesInput) {
        const table = normalizeTable(input)
        if (seen.has(table.name.toLowerCase())) throw new DesktopCoworkerShareDatabaseError('invalid', 'Duplicate table names are not portable.')
        seen.add(table.name.toLowerCase())
        totalRows += table.rows.length
        tables.push(table)
    }
    if (totalRows > DESKTOP_COWORKER_SHARE_DATABASE_LIMITS.maxTotalRows) {
        throw new DesktopCoworkerShareDatabaseError('bounds', 'Private tables exceed the portable total row limit.')
    }
    const tableNames = new Set(tables.map(table => table.name))
    const views: DesktopCoworkerShareDatabaseView[] = []
    const viewIds = new Set<string>()
    for (const input of viewsInput) {
        const view = normalizeView(input, tableNames)
        if (viewIds.has(view.id)) throw new DesktopCoworkerShareDatabaseError('invalid', 'Duplicate saved view ids are not portable.')
        viewIds.add(view.id)
        views.push(view)
    }
    if (views.length > DESKTOP_COWORKER_SHARE_DATABASE_LIMITS.maxViews) {
        throw new DesktopCoworkerShareDatabaseError('bounds', 'Too many saved views for a portable share.')
    }
    const contents = measurePackage(tables, views)
    if (contents.bytes > DESKTOP_COWORKER_SHARE_DATABASE_LIMITS.maxTotalBytes) {
        throw new DesktopCoworkerShareDatabaseError('bounds', 'Private database content exceeds the portable total size limit.')
    }
    return desktopCoworkerShareDatabasePreviewSchema.parse({
        available: true,
        contents,
        viewCount: views.length,
        digest: tables.length || views.length ? packageDigest(tables, views) : null,
    })
}

import {
    desktopCoworkerShareDatabasePackageSchema,
    desktopCoworkerShareDatabaseRestoreResultSchema,
    type DesktopCoworkerShareDatabasePackage,
    type DesktopCoworkerShareDatabaseRestoreResult,
    type DesktopCoworkerShareDatabaseTable,
    type DesktopCoworkerShareDatabaseView,
} from '@rerun/contracts'
import { DesktopCoworkerShareDatabaseError } from './errors.ts'
import { digestTable, digestView, logicalCreateTableSql, packageDigest } from './normalize.ts'

export type DesktopCoworkerShareDatabaseInstallAuthority = {
    workspaceId: number
    destinationAgentId: string
    /** Destination private DB must have no user tables (fresh coworker only). */
    assertFreshPrivateDatabase: () => Promise<void>
    /**
     * Idempotent table install. Reuse when the exact tableDigest already exists for this captureRequestId.
     * Must create schema from structured columns only — never execute SQL text from the archive.
     */
    installTable: (input: {
        captureRequestId: string
        packageDigest: string
        table: DesktopCoworkerShareDatabaseTable
        createTableSql: string
    }) => Promise<'installed' | 'reused'>
    installView: (input: {
        captureRequestId: string
        packageDigest: string
        view: DesktopCoworkerShareDatabaseView
    }) => Promise<'installed' | 'reused'>
}

export type DesktopCoworkerShareDatabaseRestoreInput = {
    expectedDigest: string
    captureRequestId: string
}

export async function restoreDesktopCoworkerShareDatabase(
    authority: DesktopCoworkerShareDatabaseInstallAuthority | null | undefined,
    rawPackage: unknown,
    input: DesktopCoworkerShareDatabaseRestoreInput,
): Promise<DesktopCoworkerShareDatabaseRestoreResult> {
    if (!authority) {
        return desktopCoworkerShareDatabaseRestoreResultSchema.parse({
            status: 'unavailable',
            captureRequestId: input.captureRequestId,
            packageDigest: input.expectedDigest,
            destinationAgentId: 'unbound',
            installedTables: [],
            reusedTables: [],
            installedViews: 0,
            reusedViews: 0,
            reason: 'Database restore is unavailable until the canonical private-database install authority is bound.',
        })
    }
    const pkg = desktopCoworkerShareDatabasePackageSchema.parse(rawPackage)
    if (pkg.captureRequestId !== input.captureRequestId) {
        throw new DesktopCoworkerShareDatabaseError('stale', 'Database package request id does not match the restore request.')
    }
    const digest = packageDigest(pkg.tables, pkg.views)
    if (digest !== pkg.digest || digest !== input.expectedDigest) {
        throw new DesktopCoworkerShareDatabaseError('stale', 'Database package digest does not match the reviewed content.')
    }
    for (const table of pkg.tables) {
        if (digestTable({ name: table.name, columns: table.columns, rows: table.rows }) !== table.tableDigest) {
            throw new DesktopCoworkerShareDatabaseError('invalid', 'Table digest failed validation.')
        }
    }
    for (const view of pkg.views) {
        if (digestView({ id: view.id, table: view.table, name: view.name, position: view.position, config: view.config }) !== view.viewDigest) {
            throw new DesktopCoworkerShareDatabaseError('invalid', 'Saved view digest failed validation.')
        }
    }

    await authority.assertFreshPrivateDatabase()

    const installedTables: string[] = []
    const reusedTables: string[] = []
    let installedViews = 0
    let reusedViews = 0
    let failed: string | undefined
    let uncertain = false

    for (const table of pkg.tables) {
        try {
            const outcome = await authority.installTable({
                captureRequestId: pkg.captureRequestId,
                packageDigest: digest,
                table,
                createTableSql: logicalCreateTableSql(table),
            })
            if (outcome === 'installed') installedTables.push(table.name)
            else reusedTables.push(table.name)
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Table install failed.'
            if (/uncertain|timeout|abort|interrupt/i.test(message)) {
                uncertain = true
                failed = `Uncertain acknowledgement while installing table "${table.name}".`
            } else {
                failed = `Partial failure installing table "${table.name}": ${message.slice(0, 200)}`
            }
            break
        }
    }

    if (!failed) {
        for (const view of pkg.views) {
            try {
                const outcome = await authority.installView({
                    captureRequestId: pkg.captureRequestId,
                    packageDigest: digest,
                    view,
                })
                if (outcome === 'installed') installedViews += 1
                else reusedViews += 1
            } catch (error) {
                const message = error instanceof Error ? error.message : 'View install failed.'
                if (/uncertain|timeout|abort|interrupt/i.test(message)) {
                    uncertain = true
                    failed = `Uncertain acknowledgement while installing saved views.`
                } else {
                    failed = `Partial failure installing saved views: ${message.slice(0, 200)}`
                }
                break
            }
        }
    }

    if (failed) {
        return desktopCoworkerShareDatabaseRestoreResultSchema.parse({
            status: uncertain ? 'uncertain' : 'partial',
            captureRequestId: pkg.captureRequestId,
            packageDigest: digest,
            destinationAgentId: authority.destinationAgentId,
            installedTables,
            reusedTables,
            installedViews,
            reusedViews,
            reason: failed,
        })
    }

    const onlyReuse = reusedTables.length && !installedTables.length && reusedViews >= pkg.views.length && !installedViews
    return desktopCoworkerShareDatabaseRestoreResultSchema.parse({
        status: onlyReuse ? 'reused' : 'installed',
        captureRequestId: pkg.captureRequestId,
        packageDigest: digest,
        destinationAgentId: authority.destinationAgentId,
        installedTables,
        reusedTables,
        installedViews,
        reusedViews,
    })
}

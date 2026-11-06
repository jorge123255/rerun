import { listViews } from '../../db/tableViews.ts'
import { exportTableRows, listTables } from '../../db/sqlStore.ts'
import { AGENT_HIDDEN_TABLES } from '../../db/agentDb.ts'
import { DesktopCoworkerShareDatabaseError } from './errors.ts'
import type { DesktopCoworkerShareDatabaseCaptureAuthority } from './capture.ts'
import type { DesktopCoworkerShareDatabaseInstallAuthority } from './restore.ts'
import type { DesktopCoworkerShareDatabaseTableInput, DesktopCoworkerShareDatabaseViewInput } from './normalize.ts'
import type { Client } from '@libsql/client'

const INTERNAL = /^(?:sqlite_|_rerun_)/i

export type DesktopCoworkerShareDatabasePrivateReader = {
    /** Open the destination/source private agent DB client. Must never point at shared.db or system.db. */
    openPrivateClient: () => Promise<Client>
}

/** Concrete observational capture over the coworker's private agent.db only. */
export function createDesktopCoworkerShareDatabaseCaptureAdapter(input: {
    workspaceId: number
    agentId: string
    reader: DesktopCoworkerShareDatabasePrivateReader | null | undefined
}): DesktopCoworkerShareDatabaseCaptureAuthority {
    if (!input.reader) {
        throw new DesktopCoworkerShareDatabaseError('unavailable', 'Database capture is unavailable until the private database reader is bound.')
    }
    const reader = input.reader
    return {
        workspaceId: input.workspaceId,
        agentId: input.agentId,
        async listPrivateSnapshot() {
            const client = await reader.openPrivateClient()
            const tablesMeta = await listTables(client, AGENT_HIDDEN_TABLES)
            const tables: DesktopCoworkerShareDatabaseTableInput[] = []
            for (const meta of tablesMeta) {
                if (INTERNAL.test(meta.name)) continue
                const exported = await exportTableRows(client, meta.name, { hidden: AGENT_HIDDEN_TABLES })
                tables.push({
                    name: meta.name,
                    columns: meta.columns.map(column => ({
                        name: column.name,
                        type: column.type || 'TEXT',
                        pk: column.pk,
                        notnull: column.notnull,
                    })),
                    rows: exported.rows.map(row => {
                        const next: Record<string, unknown> = {}
                        for (const column of exported.columns) next[column] = row[column] ?? null
                        return next
                    }),
                })
            }
            const views: DesktopCoworkerShareDatabaseViewInput[] = []
            for (const table of tables) {
                const saved = await listViews(client, table.name, AGENT_HIDDEN_TABLES)
                for (const view of saved) {
                    views.push({
                        id: view.id,
                        table: view.table,
                        name: view.name,
                        position: view.position,
                        config: {
                            layout: view.layout,
                            columns: view.columns,
                            fields: view.fields,
                            formats: view.formats,
                            tones: view.tones,
                            groupBy: view.groupBy,
                            display: view.display,
                            sort: view.sort,
                            where: view.where,
                        },
                    })
                }
            }
            return { tables, views }
        },
    }
}

export type DesktopCoworkerShareDatabaseTableWriter = (input: {
    destinationAgentId: string
    tableName: string
    createTableSql: string
    columns: { name: string; type: string; pk: boolean; notnull: boolean }[]
    rows: Record<string, unknown>[]
    tableDigest: string
    recoveryKey: string
}) => Promise<'installed' | 'reused'>

export type DesktopCoworkerShareDatabaseViewWriter = (input: {
    destinationAgentId: string
    view: {
        id: string
        table: string
        name: string
        position: number
        config: unknown
    }
    viewDigest: string
    recoveryKey: string
}) => Promise<'installed' | 'reused'>

export type DesktopCoworkerShareDatabaseFreshnessCheck = () => Promise<{ userTableCount: number }>

/**
 * Concrete install adapter. Fails closed without writers.
 * Writers must apply structured schema/rows/views — never run archive-provided SQL strings verbatim
 * except the allowlisted CREATE produced by logicalCreateTableSql from validated columns.
 */
export function createDesktopCoworkerShareDatabaseInstallAdapter(input: {
    workspaceId: number
    destinationAgentId: string
    checkFresh: DesktopCoworkerShareDatabaseFreshnessCheck | null | undefined
    writeTable: DesktopCoworkerShareDatabaseTableWriter | null | undefined
    writeView: DesktopCoworkerShareDatabaseViewWriter | null | undefined
}): DesktopCoworkerShareDatabaseInstallAuthority {
    if (!input.checkFresh || !input.writeTable || !input.writeView) {
        throw new DesktopCoworkerShareDatabaseError('unavailable', 'Database restore is unavailable until the canonical private-database install writers are bound.')
    }
    const checkFresh = input.checkFresh
    const writeTable = input.writeTable
    const writeView = input.writeView
    const seenTables = new Map<string, 'installed' | 'reused'>()
    const seenViews = new Map<string, 'installed' | 'reused'>()
    return {
        workspaceId: input.workspaceId,
        destinationAgentId: input.destinationAgentId,
        async assertFreshPrivateDatabase() {
            const { userTableCount } = await checkFresh()
            if (userTableCount > 0) {
                throw new DesktopCoworkerShareDatabaseError('conflict', 'Database restore requires a fresh private database with no existing user tables.')
            }
        },
        async installTable({ captureRequestId, packageDigest, table, createTableSql }) {
            if (!createTableSql.startsWith('CREATE TABLE IF NOT EXISTS ') || createTableSql.includes(';') || /--|\/\*|\battach\b|\bpragma\b/i.test(createTableSql)) {
                throw new DesktopCoworkerShareDatabaseError('invalid', 'Refusing non-allowlisted table DDL.')
            }
            const recoveryKey = `${captureRequestId}:${packageDigest}:table:${table.name}:${table.tableDigest}`
            const prior = seenTables.get(recoveryKey)
            if (prior) return prior
            const outcome = await writeTable({
                destinationAgentId: input.destinationAgentId,
                tableName: table.name,
                createTableSql,
                columns: table.columns,
                rows: table.rows,
                tableDigest: table.tableDigest,
                recoveryKey,
            })
            seenTables.set(recoveryKey, outcome)
            return outcome
        },
        async installView({ captureRequestId, packageDigest, view }) {
            const recoveryKey = `${captureRequestId}:${packageDigest}:view:${view.id}:${view.viewDigest}`
            const prior = seenViews.get(recoveryKey)
            if (prior) return prior
            const outcome = await writeView({
                destinationAgentId: input.destinationAgentId,
                view: {
                    id: view.id,
                    table: view.table,
                    name: view.name,
                    position: view.position,
                    config: view.config,
                },
                viewDigest: view.viewDigest,
                recoveryKey,
            })
            seenViews.set(recoveryKey, outcome)
            return outcome
        },
    }
}

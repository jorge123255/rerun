import type { Client } from '@libsql/client'
import { tableViewSchema, type TableView, type TableViewInput } from '@rerun/contracts'
import { assertPlainDataSchema } from '../data-store.js'
import { deleteView, listViews, saveView } from '../../db/tableViews.js'

export class DesktopTableViewConflictError extends Error {
    constructor() {
        super('This view changed while the request was being admitted. Review the current view before trying again.')
        this.name = 'DesktopTableViewConflictError'
    }
}

export class DesktopTableViewCommitUnknownError extends Error {
    constructor() {
        super('The view write outcome is not confirmed. Inspect the current view before retrying; do not repeat the write automatically.')
        this.name = 'DesktopTableViewCommitUnknownError'
    }
}

type Scope = { client: Client; hidden: string[]; table: string }
type Lifecycle = {
    signal?: AbortSignal
    beforeTransaction?: () => Promise<void>
    afterCommit?: () => Promise<void>
}

function assertUserTable(table: string): void {
    if (/^(?:sqlite_|_rerun_)/i.test(table)) throw new Error('Table not found.')
}

async function exactView(client: Client, table: string, name: string, hidden: string[]): Promise<TableView | null> {
    return (await listViews(client, table, hidden)).find(view => view.name === name) ?? null
}

function sameView(a: TableView | null, b: TableView | null): boolean {
    if (!a || !b) return a === b
    return JSON.stringify(tableViewSchema.parse(a)) === JSON.stringify(tableViewSchema.parse(b))
}

async function write<T>(
    scope: Scope,
    name: string,
    expected: TableView | null,
    lifecycle: Lifecycle,
    operation: (client: Client) => Promise<T>,
): Promise<T> {
    await lifecycle.beforeTransaction?.()
    lifecycle.signal?.throwIfAborted()
    const tx = await scope.client.transaction('write')
    let result: T
    try {
        await assertPlainDataSchema(tx)
        assertUserTable(scope.table)
        const current = await exactView(tx as unknown as Client, scope.table, name, scope.hidden)
        if (!sameView(expected, current)) throw new DesktopTableViewConflictError()
        result = await operation(tx as unknown as Client)
        lifecycle.signal?.throwIfAborted()
        await tx.commit()
    } catch (error) {
        await tx.rollback().catch(() => {})
        throw error
    } finally {
        tx.close()
    }
    try {
        await lifecycle.afterCommit?.()
        lifecycle.signal?.throwIfAborted()
    } catch {
        throw new DesktopTableViewCommitUnknownError()
    }
    return result
}

export async function saveDesktopTableView(input: Scope & { input: TableViewInput } & Lifecycle): Promise<TableView> {
    assertUserTable(input.table)
    const expected = await exactView(input.client, input.table, input.input.name, input.hidden)
    return write(input, input.input.name, expected, input, async client =>
        saveView(client, input.table, { ...input.input, layout: input.input.layout ?? 'table' }, { hidden: input.hidden, replaceByName: true }),
    )
}

export async function deleteDesktopTableView(input: Scope & { name: string } & Lifecycle): Promise<boolean> {
    assertUserTable(input.table)
    const expected = await exactView(input.client, input.table, input.name, input.hidden)
    if (!expected) return false
    return write(input, input.name, expected, input, client => deleteView(client, input.table, input.name))
}

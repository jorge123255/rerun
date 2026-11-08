import { tool, type ToolSet } from 'ai'
import { z } from 'zod'
import type { AgentConfig, TableView, TableViewInput } from '@rerun/contracts'
import { withAgentLock } from '../../agents/lock.js'
import { readAgentConfig } from '../../agents/loader.js'
import { agentDataDbPath, dataDir, sharedDbPath } from '../../config/paths.js'
import { AGENT_HIDDEN_TABLES, getAgentDb } from '../../db/agentDb.js'
import { getSharedDb, SHARED_HIDDEN_TABLES } from '../../db/sharedDb.js'
import { tableDisplayInput, tableTargetInput } from '../../tools/builtin/table-card.js'
import type { RunContext } from '../../runtime/context.js'
import { beginDesktopAgentWork } from '../agent-lifecycle.js'
import { DATA_DEADLINE_MS, prepareDesktopDataFile, verifyDesktopDataFile } from '../data-executor.js'
import { hasDesktopDataGrant } from '../data-tools.js'
import { deleteDesktopTableView, DesktopTableViewCommitUnknownError, saveDesktopTableView } from './store.js'

export type DesktopTableViewAuthorization = (config: AgentConfig) => boolean
export type DesktopTableViewScope = 'agent' | 'shared'

export type DesktopTableViewAdapters = {
    save(ctx: RunContext, scope: DesktopTableViewScope, input: TableViewInput & { table: string }): Promise<TableView>
    delete(ctx: RunContext, scope: DesktopTableViewScope, table: string, name: string): Promise<boolean>
}

export const DESKTOP_TABLE_VIEW_INSTRUCTION =
    'table_view_save saves a named view of an existing table, with validated columns, filters, sort and layout; saving under an existing name replaces that view only when it has not changed concurrently. table_view_delete removes only the named view and never deletes table rows. Both need the view-write permission and the matching private or shared database permission. Use card_table to show the saved view afterward. Keep the human Database view editor available, report concurrent changes honestly, and inspect the current view after an uncertain acknowledgement instead of retrying automatically.'

async function requireScope(ctx: RunContext, scope: DesktopTableViewScope, authorized: DesktopTableViewAuthorization): Promise<void> {
    ctx.abortSignal?.throwIfAborted()
    const config = await readAgentConfig(ctx.agent.id).catch(() => null)
    ctx.abortSignal?.throwIfAborted()
    if (!config?.enabled || !authorized(config)) throw new Error('Saved view editing is turned off for this coworker.')
    if (!hasDesktopDataGrant(config, scope === 'shared' ? 'sharedDb' : 'db')) throw new Error('This database is turned off for this coworker.')
}

function tableViewScope(value: unknown): DesktopTableViewScope {
    if (value !== 'agent' && value !== 'shared') throw new Error('That view does not name a private or shared database.')
    return value
}

function productionAdapters(authorized: DesktopTableViewAuthorization): DesktopTableViewAdapters {
    const scope = async (ctx: RunContext, scopeName: DesktopTableViewScope) => {
        const shared = scopeName === 'shared'
        const pin = await prepareDesktopDataFile(dataDir(), shared ? sharedDbPath() : agentDataDbPath(ctx.agent.id))
        ctx.abortSignal?.throwIfAborted()
        const client = shared ? await getSharedDb() : await getAgentDb(ctx.agent.id)
        const verify = () => verifyDesktopDataFile(pin)
        await verify()
        return {
            client,
            hidden: shared ? SHARED_HIDDEN_TABLES : AGENT_HIDDEN_TABLES,
            signal: ctx.abortSignal,
            beforeTransaction: verify,
            beforeCommit: verify,
            afterCommit: async () => { await verify(); await requireScope(ctx, scopeName, authorized) },
        }
    }
    return {
        save: async (ctx, scopeName, { table, ...input }) => saveDesktopTableView({
            ...(await scope(ctx, scopeName)), table, input,
        }),
        delete: async (ctx, scopeName, table, name) => deleteDesktopTableView({
            ...(await scope(ctx, scopeName)), table, name,
        }),
    }
}

function withAdmission<T>(ctx: RunContext, action: () => Promise<T>): Promise<T> {
    ctx.abortSignal?.throwIfAborted()
    return new Promise<T>((resolve, reject) => {
        let entered = false
        let canceled: unknown
        const cancel = (reason: unknown) => {
            if (entered || canceled !== undefined) return
            canceled = reason
            reject(reason)
            clearTimeout(timer)
            ctx.abortSignal?.removeEventListener('abort', abort)
        }
        const abort = () => cancel(ctx.abortSignal?.reason ?? new DOMException('Database request canceled.', 'AbortError'))
        const timer = setTimeout(() => cancel(new Error('Database request waited too long for this coworker.')), DATA_DEADLINE_MS)
        ctx.abortSignal?.addEventListener('abort', abort, { once: true })
        if (ctx.abortSignal?.aborted) abort()
        void withAgentLock(ctx.agent.id, async () => {
            if (canceled !== undefined) throw canceled
            ctx.abortSignal?.throwIfAborted()
            entered = true
            clearTimeout(timer)
            ctx.abortSignal?.removeEventListener('abort', abort)
            return action()
        }).then(resolve, reject).finally(() => {
            clearTimeout(timer)
            ctx.abortSignal?.removeEventListener('abort', abort)
        })
    })
}

export function desktopTableViewTools(
    ctx: RunContext,
    authorized: DesktopTableViewAuthorization = () => false,
    adapters?: DesktopTableViewAdapters,
): ToolSet {
    if (!authorized(ctx.agent.config) || !hasDesktopDataGrant(ctx.agent.config, 'db') && !hasDesktopDataGrant(ctx.agent.config, 'sharedDb')) return {}
    const ports = adapters ?? productionAdapters(authorized)
    return {
        table_view_save: tool({
            description:
                'Save a view of one of your tables: a named way to draw it (table, list, gallery or board) and which rows it shows, that the user finds as a tab when they open the table in the app, and the only thing card_table can show. Save one right after creating a table the user will browse, and another for each selection worth showing on its own. Saving under an existing name replaces that view; a concurrent edit is reported instead of overwritten. Only change or delete a view the user made when they ask. Requires the view-write permission and the matching database permission.',
            inputSchema: z.object({ ...tableTargetInput, name: z.string().min(1).max(60).describe('Name of the view, shown as its tab'), ...tableDisplayInput }),
            execute: async ({ scope, table, ...input }) => {
                try {
                    return await withAdmission(ctx, async () => {
                        const release = beginDesktopAgentWork(ctx.agent.id)
                        try {
                            const named = tableViewScope(scope)
                            await requireScope(ctx, named, authorized)
                            const layout = input.layout ?? 'table'
                            const view = await ports.save(ctx, named, { ...input, table, layout })
                            return `Saved the ${view.layout} view "${view.name}" on ${table}. The user sees it as a tab of the table in the app; show it in the chat with card_table and view "${view.name}".`
                        } finally { release() }
                    })
                } catch (error) {
                    if (error instanceof DesktopTableViewCommitUnknownError) throw error
                    ctx.abortSignal?.throwIfAborted()
                    throw new Error(`Could not save that view: ${error instanceof Error ? error.message : 'The database request failed.'}`)
                }
            },
        }),
        table_view_delete: tool({
            description: 'Delete a saved view of one of your tables, by name. The rows are untouched. Requires the view-write permission and the matching database permission.',
            inputSchema: z.object({ ...tableTargetInput, name: z.string().describe('Name of the view to delete') }),
            execute: async ({ scope, table, name }) => {
                try {
                    return await withAdmission(ctx, async () => {
                        const release = beginDesktopAgentWork(ctx.agent.id)
                        try {
                            const named = tableViewScope(scope)
                            await requireScope(ctx, named, authorized)
                            return await ports.delete(ctx, named, table, name)
                                ? `Deleted the view "${name}" of ${table}.`
                                : `${table} has no view named "${name}".`
                        } finally { release() }
                    })
                } catch (error) {
                    if (error instanceof DesktopTableViewCommitUnknownError) throw error
                    ctx.abortSignal?.throwIfAborted()
                    throw new Error(`Could not delete that view: ${error instanceof Error ? error.message : 'The database request failed.'}`)
                }
            },
        }),
    }
}

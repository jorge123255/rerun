import { tool, type ToolSet } from 'ai'
import { z } from 'zod'
import { CARD_MAX_ROWS, type AgentConfig } from '@rerun/contracts'
import { withAgentLock } from '../agents/lock.js'
import { readAgentConfig } from '../agents/loader.js'
import { AGENT_HIDDEN_TABLES } from '../db/agentDb.js'
import { SHARED_HIDDEN_TABLES } from '../db/sharedDb.js'
import { agentDataDbPath, dataDir, sharedDbPath, sharedDir, workspaceDir } from '../config/paths.js'
import type { RunContext } from '../runtime/context.js'
import { beginDesktopAgentWork } from './agent-lifecycle.js'
import { DATA_DEADLINE_MS, executeDesktopData, type DataCardResult } from './data-executor.js'
import { hasDesktopDataGrant } from './data-tools.js'

/**
 * The Mac app's card_table is display-only, on top of the database grants it already has.
 * Drawing rows is a separate, default-off permission: root owns the `cardTable` grant id and its
 * Tools row, and supplies the check here, so this module never widens a permission by itself.
 */
export type DesktopCardTableAuthorization = (config: AgentConfig) => boolean

/** Root appends this where it composes the Mac coworker prompt. */
export const DESKTOP_CARD_TABLE_INSTRUCTION =
    'card_table shows the user the first rows of a saved view of a table, drawn the way that view draws them, with a button that opens the live table on that view. It only shows saved views: create or change one in the Database view editor. Use it right after you filled a table the user will browse, instead of describing the rows in your answer. It does not read anything back to you: use db_query or shared_db_query when you need the content yourself. A card is a frozen snapshot; a missing view is reported as missing, never replaced by another one.'

type CardScope = 'agent' | 'shared'

/** The Mac app has no table_view_save tool, so the schema names the view editor the user does have. */
const cardTableInput = z.object({
    scope: z.enum(['agent', 'shared']).describe("'agent' for this coworker’s private database, 'shared' for the workspace database every permitted coworker shares"),
    table: z.string().min(1).max(200).describe('Name of the table'),
    view: z.string().min(1).max(200).describe('Name of a view saved on this table in the app. The card draws it exactly like that view, and its button opens the table on that tab.'),
    limit: z
        .number()
        .int()
        .min(1)
        .max(CARD_MAX_ROWS)
        .optional()
        .describe('How many rows the card shows: 5 by default, 6 for a gallery. On a board, how many cards under each column, 3 by default.'),
})

function withCardAdmission<T>(ctx: RunContext, action: () => Promise<T>): Promise<T> {
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

async function requireCardScope(ctx: RunContext, scope: CardScope, authorized: DesktopCardTableAuthorization): Promise<void> {
    ctx.abortSignal?.throwIfAborted()
    const config = await readAgentConfig(ctx.agent.id).catch(() => null)
    ctx.abortSignal?.throwIfAborted()
    if (!config || !authorized(config)) throw new Error('Result cards are turned off for this coworker.')
    if (!hasDesktopDataGrant(config, scope === 'shared' ? 'sharedDb' : 'db')) throw new Error('This database is turned off for this coworker.')
}

/** A card resolves a saved view and freezes its rows inside the killable SQL worker: never a
 * second transport, never arbitrary SQL, never a read on the engine event loop. */
export function desktopTableCardTools(ctx: RunContext, authorized: DesktopCardTableAuthorization = () => false): ToolSet {
    if (!authorized(ctx.agent.config)) return {}
    return {
        card_table: tool({
            description:
                'Show the user the first rows of one of the views saved on a table, drawn exactly the way that view draws them, with a button that opens the live table on that view. scope \'agent\' is this coworker\'s private database, \'shared\' the workspace database every permitted coworker shares; each needs its own database permission as well. Up to 20 rows, eight columns and six board groups; values are frozen into the card as you see them now. Only saved views can be shown, and a view must be one the table already has: when it has none, or the name is wrong, the tool says which views exist. Create or change a view in the app\'s Database view editor, not from chat. This is display only and reads nothing back to you: use db_query or shared_db_query to inspect rows yourself.',
            inputSchema: cardTableInput,
            execute: async ({ scope, table, view, limit }) => {
                try {
                    return await withCardAdmission(ctx, async () => {
                        const release = beginDesktopAgentWork(ctx.agent.id)
                        try {
                            await requireCardScope(ctx, scope, authorized)
                            const shared = scope === 'shared'
                            const card = await executeDesktopData(
                                dataDir(),
                                shared ? sharedDbPath() : agentDataDbPath(ctx.agent.id),
                                {
                                    kind: 'card',
                                    table,
                                    view,
                                    ...(limit === undefined ? {} : { limit }),
                                    hidden: shared ? SHARED_HIDDEN_TABLES : AGENT_HIDDEN_TABLES,
                                    workspace: shared ? sharedDir() : workspaceDir(ctx.agent.id),
                                },
                                { signal: ctx.abortSignal, databaseKind: shared ? 'shared' : 'private' },
                            ) as DataCardResult
                            await requireCardScope(ctx, scope, authorized)
                            return JSON.stringify(card)
                        } finally { release() }
                    })
                } catch (error) {
                    // Stop must reach the provider as cancellation, not as a card that merely says it failed.
                    ctx.abortSignal?.throwIfAborted()
                    throw new Error(`Could not show that table: ${error instanceof Error ? error.message : 'The database request failed.'}`)
                }
            },
        }),
    }
}

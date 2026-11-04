import { tool, type ToolSet } from 'ai'
import { z } from 'zod'
import { withAgentLock } from '../agents/lock.js'
import { readAgentConfig } from '../agents/loader.js'
import { AGENT_HIDDEN_TABLES } from '../db/agentDb.js'
import { SHARED_HIDDEN_TABLES } from '../db/sharedDb.js'
import { beginDesktopAgentWork } from './agent-lifecycle.js'
import type { RunContext } from '../runtime/context.js'
import { agentDataDbPath, dataDir, sharedDbPath } from '../config/paths.js'
import { DATA_DEADLINE_MS, DesktopDataCommitUnknownError, executeDesktopData, type DataQueryResult, type DataWriteResult } from './data-executor.js'

export const DESKTOP_DATA_GRANTS = ['db', 'sharedDb'] as const
export type DesktopDataGrant = typeof DESKTOP_DATA_GRANTS[number]
export function hasDesktopDataGrant(config: { enabled: boolean; tools: { desktopToolGrants?: unknown } }, grant: DesktopDataGrant): boolean {
    const grants = config.tools.desktopToolGrants
    return config.enabled && !!grants && typeof grants === 'object' && (grants as Record<string, unknown>)[grant] === true
}
async function requireGrant(ctx: RunContext, grant: DesktopDataGrant) {
    ctx.abortSignal?.throwIfAborted()
    const config = await readAgentConfig(ctx.agent.id).catch(() => null)
    ctx.abortSignal?.throwIfAborted()
    if (!config || !hasDesktopDataGrant(config, grant)) throw new Error('This database is turned off for this coworker.')
}
/** Only queue admission is raced. Once admitted, cancellation must reap the SQL worker before
 * releasing the real agent lock. A canceled queued callback stays inert when its turn arrives. */
function withDataAdmission<T>(ctx: RunContext, action: () => Promise<T>): Promise<T> {
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
async function guarded(ctx: RunContext, grant: DesktopDataGrant, label: string, action: () => Promise<string>): Promise<string> {
    try {
        return await withDataAdmission(ctx, async () => {
            const release = beginDesktopAgentWork(ctx.agent.id)
            try { await requireGrant(ctx, grant); return await action() }
            finally { release() }
        })
    } catch (error) {
        // The provider must receive a tool error, not a successful string which merely says
        // "failed". Preserve uncertainty after commit permission even if Stop caused the loss.
        if (!(error instanceof DesktopDataCommitUnknownError)) ctx.abortSignal?.throwIfAborted()
        throw new Error(`${label} failed: ${error instanceof Error ? error.message : 'The database request failed.'}`)
    }
}
const params = z.array(z.union([z.string().max(50_000), z.number().finite(), z.boolean(), z.null()])).max(500).default([])
const sql = z.string().min(1).max(20_000)
const queryInput = z.object({ sql, params, limit: z.number().int().min(1).max(200).default(100) }).strict()
const writeInput = z.object({ sql: sql.optional(), params, statements: z.array(z.object({ sql, params }).strict()).min(1).max(100).optional() }).strict()
    .refine(value => (value.sql !== undefined) !== (value.statements !== undefined), 'Provide either sql or statements, not both.')
function toolsFor(ctx: RunContext, grant: DesktopDataGrant): ToolSet {
    if (!hasDesktopDataGrant(ctx.agent.config, grant)) return {}
    const shared = grant === 'sharedDb'
    const prefix = shared ? 'shared_db' : 'db'
    const database = shared ? 'the workspace shared database' : 'your own private SQLite database'
    const hidden = shared ? SHARED_HIDDEN_TABLES : AGENT_HIDDEN_TABLES
    const file = () => shared ? sharedDbPath() : agentDataDbPath(ctx.agent.id)
    const databaseKind = shared ? 'shared' : 'private'
    return {
        [`${prefix}_query`]: tool({
            description: `Run one read-only SELECT (or WITH … SELECT) against ${database}. Use ? placeholders and params. Returns at most 200 rows; extra rows are explicitly marked. Internal tables, file functions, extensions and PRAGMA are unavailable.`,
            inputSchema: queryInput,
            execute: input => guarded(ctx, grant, 'Query', async () => {
                const result = await executeDesktopData(dataDir(), file(), { kind: 'query', ...input, hidden }, { signal: ctx.abortSignal, databaseKind }) as DataQueryResult
                await requireGrant(ctx, grant)
                let rows = result.rows
                let encoded = JSON.stringify(rows)
                while (encoded.length > 49_000 && rows.length) { rows = rows.slice(0, -1); encoded = JSON.stringify(rows) }
                const truncated = result.truncated || rows.length !== result.rows.length
                return `${rows.length} row(s)${truncated ? ' returned (additional data omitted)' : ''}\n${encoded}${truncated ? `\n[truncated to ${rows.length} rows / 50000 characters]` : ''}`
            }),
        }),
        [`${prefix}_execute`]: tool({
            description: `Change ${database} with explicit CREATE/ALTER/DROP TABLE or INSERT/UPDATE/DELETE statements. Use ? placeholders. A statements list commits atomically or rolls back in full. No views, triggers, virtual tables, filesystem operations, extensions, transaction commands or RETURNING. ${shared ? 'Creator metadata is advisory; the shared grant permits changes regardless of which coworker created a table.' : ''}`,
            inputSchema: writeInput,
            execute: input => guarded(ctx, grant, 'Execution', async () => {
                const statements = input.statements ?? [{ sql: input.sql!, params: input.params }]
                const result = await executeDesktopData(dataDir(), file(), {
                    kind: 'execute', statements, hidden, ...(shared ? { creator: ctx.agent.config.name } : {}),
                }, { signal: ctx.abortSignal, databaseKind, beforeCommit: () => requireGrant(ctx, grant) }) as DataWriteResult
                return `OK, ${result.statements} statement(s), ${result.rowsAffected} row(s) affected${result.lastInsertRowid !== null ? `, lastInsertRowid=${result.lastInsertRowid}` : ''}`
            }),
        }),
        [`${prefix}_schema`]: tool({
            description: `Inspect tables, columns and types in ${database}. Table creator metadata is advisory, never permission.`,
            inputSchema: z.object({}).strict(),
            execute: () => guarded(ctx, grant, 'Schema read', async () => {
                const schema = await executeDesktopData(dataDir(), file(), { kind: 'schema', hidden }, { signal: ctx.abortSignal, databaseKind }) as string
                await requireGrant(ctx, grant)
                return schema.length > 8_000 ? schema.slice(0, 8_000) + '\n[Schema truncated]' : schema || `No tables yet. Create one with ${prefix}_execute (CREATE TABLE IF NOT EXISTS ...).`
            }),
        }),
    }
}
export const desktopDbTools = (ctx: RunContext) => toolsFor(ctx, 'db')
export const desktopSharedDbTools = (ctx: RunContext) => toolsFor(ctx, 'sharedDb')

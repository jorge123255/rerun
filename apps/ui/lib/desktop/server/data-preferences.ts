import 'server-only'
import type { Client } from '@libsql/client'
import { z } from 'zod'
import type { DesktopDataScope } from '../data-scope'
import { DesktopHttpError } from './auth'
import { assertCoworkerNotDeleting } from './coworker-delete'
import { withRosterWrite } from './roster-writes'

const tableName = z.string().min(1).max(200).refine(value => !/[\u0000-\u001f]/.test(value) && !/^(?:sqlite_|_rerun_)/i.test(value))
const viewId = z.string().min(1).max(128).refine(value => !/[\u0000-\u001f]/.test(value)).nullable()
export const desktopDataPreferenceSchema = z.object({ table: tableName, viewId }).strict()

async function owner(db: Client, scope: DesktopDataScope) {
    if (scope.kind === 'shared') return { key: 'shared', agentId: null }
    await assertCoworkerNotDeleting(db, scope.agentId)
    const found = await db.execute({ sql: 'SELECT id FROM desktop_agents WHERE id=? AND workspace_id=1', args: [scope.agentId] })
    if (!found.rows.length) throw new DesktopHttpError(404, 'Coworker not found')
    return { key: `agent:${scope.agentId}`, agentId: scope.agentId }
}
function parseTable(raw: unknown): string {
    const parsed = tableName.safeParse(raw)
    if (!parsed.success) throw new DesktopHttpError(400, 'Choose a valid table.')
    return parsed.data
}
export async function readDesktopDataPreference(db: Client, scope: DesktopDataScope, rawTable: unknown): Promise<string | null> {
    const table = parseTable(rawTable)
    const target = await owner(db, scope)
    const rows = await db.execute({ sql: 'SELECT view_id FROM desktop_data_preferences WHERE workspace_id=1 AND scope_key=? AND table_name=?', args: [target.key, table] })
    return rows.rows.length ? String(rows.rows[0].view_id) : null
}
export async function writeDesktopDataPreference(db: Client, scope: DesktopDataScope, raw: unknown): Promise<void> {
    const parsed = desktopDataPreferenceSchema.safeParse(raw)
    if (!parsed.success) throw new DesktopHttpError(400, 'Invalid preferred view.')
    await withRosterWrite(async () => {
        const target = await owner(db, scope)
        if (parsed.data.viewId === null) {
            await db.execute({ sql: 'DELETE FROM desktop_data_preferences WHERE workspace_id=1 AND scope_key=? AND table_name=?', args: [target.key, parsed.data.table] })
        } else {
            await db.execute({ sql: `INSERT INTO desktop_data_preferences(scope_key,workspace_id,agent_id,table_name,view_id) VALUES (?,1,?,?,?)
                ON CONFLICT(scope_key,table_name) DO UPDATE SET view_id=excluded.view_id`, args: [target.key, target.agentId, parsed.data.table, parsed.data.viewId] })
        }
    })
}

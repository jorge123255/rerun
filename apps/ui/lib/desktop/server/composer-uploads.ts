import 'server-only'
import type { Client } from '@libsql/client'
import { desktopImageKindForName } from '../composer-image'
import { desktopUploadAttemptSchema, type DesktopUploadAttempt } from '../composer-upload-attempts'
import { DesktopHttpError } from './auth'
import { assertCoworkerNotDeleting } from './coworker-delete'
import { withRosterWrite } from './roster-writes'
import { findDesktopAgent, findDesktopSession } from './store'

export const desktopComposerUploadsSchema = `CREATE TABLE IF NOT EXISTS desktop_composer_uploads (
    id TEXT PRIMARY KEY, agent_id TEXT NOT NULL REFERENCES desktop_agents(id) ON DELETE CASCADE,
    tab_uid TEXT NOT NULL, name TEXT NOT NULL, size INTEGER NOT NULL, created_at TEXT NOT NULL
)`
export async function ensureDesktopComposerUploadsSchema(db: Client) { await db.execute(desktopComposerUploadsSchema) }

async function target(db: Client, agentId: string, tabUid: string, signal?: AbortSignal) {
    signal?.throwIfAborted()
    await assertCoworkerNotDeleting(db, agentId)
    if (!await findDesktopAgent(db, agentId)) throw new DesktopHttpError(404, 'Coworker not found')
    const found = await db.execute({ sql: `SELECT json_extract(t.value, '$.id') AS session_id
        FROM desktop_agent_tabs a, json_each(a.layout, '$.tabs') t
        WHERE a.agent_id = ? AND json_extract(t.value, '$.uid') = ?`, args: [agentId, tabUid] })
    if (!found.rows.length) throw new DesktopHttpError(404, 'This conversation tab is closed.')
    const sessionId = found.rows[0].session_id
    if (sessionId !== null && (await findDesktopSession(db, String(sessionId)))?.agentId !== agentId) throw new DesktopHttpError(404, 'Conversation not found for this coworker')
    signal?.throwIfAborted()
}
export function readDesktopComposerUploads(db: Client, agentId: string, tabUid: string, signal?: AbortSignal) {
    return withRosterWrite(async () => {
        await ensureDesktopComposerUploadsSchema(db)
        await target(db, agentId, tabUid, signal)
        const result = await db.execute({ sql: 'SELECT id,name,size FROM desktop_composer_uploads WHERE agent_id=? AND tab_uid=? ORDER BY created_at,id', args: [agentId, tabUid] })
        signal?.throwIfAborted()
        return { attempts: result.rows.map(row => desktopUploadAttemptSchema.parse({ id: row.id, name: row.name, size: Number(row.size) })) }
    })
}
export function reserveDesktopComposerUpload(db: Client, agentId: string, tabUid: string, attempt: DesktopUploadAttempt, signal?: AbortSignal) {
    return withRosterWrite(async () => {
        await ensureDesktopComposerUploadsSchema(db)
        await target(db, agentId, tabUid, signal)
        const existing = (await db.execute({ sql: 'SELECT * FROM desktop_composer_uploads WHERE id=?', args: [attempt.id] })).rows[0]
        if (existing) {
            if (existing.agent_id !== agentId || existing.tab_uid !== tabUid || existing.name !== attempt.name || Number(existing.size) !== attempt.size) throw new DesktopHttpError(409, 'This upload status belongs to another attempt.')
            return { created: false, attempt }
        }
        const current = (await db.execute({ sql: 'SELECT name FROM desktop_composer_uploads WHERE agent_id=? AND tab_uid=?', args: [agentId, tabUid] })).rows
        const isImage = (name: string) => desktopImageKindForName(name) !== null
        const image = isImage(attempt.name)
        if (current.length >= 14 || current.filter(row => isImage(String(row.name)) === image).length >= (image ? 4 : 10)) throw new DesktopHttpError(409, 'Check and dismiss unresolved imports before adding more files.')
        signal?.throwIfAborted()
        await db.execute({ sql: 'INSERT INTO desktop_composer_uploads (id,agent_id,tab_uid,name,size,created_at) VALUES (?,?,?,?,?,?)', args: [attempt.id, agentId, tabUid, attempt.name, attempt.size, new Date().toISOString()] })
        return { created: true, attempt }
    })
}
export function dismissDesktopComposerUpload(db: Client, agentId: string, tabUid: string, id: string, signal?: AbortSignal) {
    return withRosterWrite(async () => {
        await ensureDesktopComposerUploadsSchema(db)
        await target(db, agentId, tabUid, signal)
        await db.execute({ sql: 'DELETE FROM desktop_composer_uploads WHERE id=? AND agent_id=? AND tab_uid=?', args: [id, agentId, tabUid] })
        return { dismissed: true }
    })
}

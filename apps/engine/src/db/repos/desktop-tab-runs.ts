import { getSystemDb } from '../systemDb.js'
import { HttpError } from '../../lib/errors.js'
import { nowIso } from '../../lib/ids.js'

// The authenticated Mac bridge reserves these two IDs once for this coworker's blank tab.
// A lost response or simultaneous retry must attach to its existing run, never start another.
export async function startDesktopTabRun(agentId: string, sessionId: string, runId: string): Promise<boolean> {
    const { client } = await getSystemDb(agentId)
    const now = nowIso()
    const [session, run, existing] = await client.batch([{
        sql: 'INSERT INTO sessions (id, agent_id, created_at, updated_at) VALUES (?,?,?,?) ON CONFLICT(id) DO NOTHING',
        args: [sessionId, agentId, now, now],
    }, {
        sql: 'INSERT INTO runs (id, agent_id, session_id, started_at) SELECT ?,?,?,? WHERE changes()=1',
        args: [runId, agentId, sessionId, now],
    }, {
        sql: 'SELECT id FROM runs WHERE id=? AND session_id=? AND agent_id=?', args: [runId, sessionId, agentId],
    }], 'write')
    if (!existing.rows.length) throw new HttpError(409, 'This conversation belongs to a different first turn.')
    return session.rowsAffected === 1 && run.rowsAffected === 1
}

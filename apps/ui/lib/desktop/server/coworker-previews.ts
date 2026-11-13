import 'server-only'
import type { Client } from '@libsql/client'
import { desktopCoworkerPreviewsSchema, type DesktopCoworkerPreviews } from '../coworker-previews'

// One row per coworker of this workspace that has a conversation: the one touched last. A coworker
// being removed is left out, as on the board.
export async function readDesktopCoworkerPreviews(db: Pick<Client, 'execute'>): Promise<DesktopCoworkerPreviews> {
    const { rows } = await db.execute(`SELECT s.agent_id, s.title, s.updated_at FROM desktop_sessions s
        JOIN desktop_agents a ON a.id = s.agent_id AND a.workspace_id = 1
        WHERE NOT EXISTS (SELECT 1 FROM desktop_deletions d WHERE d.agent_id = a.id)
        AND NOT EXISTS (SELECT 1 FROM desktop_sessions x WHERE x.agent_id = s.agent_id
            AND (x.updated_at > s.updated_at OR (x.updated_at = s.updated_at AND x.id > s.id)))`)
    return desktopCoworkerPreviewsSchema.parse({
        previews: Object.fromEntries(rows.map(row => [String(row.agent_id), { title: String(row.title), updatedAt: String(row.updated_at) }])),
    })
}

import 'server-only'
import type { Client } from '@libsql/client'

export async function initializeDesktopDataPreferences(db: Client) {
    await db.execute(`CREATE TABLE IF NOT EXISTS desktop_data_preferences (
        scope_key TEXT NOT NULL,
        workspace_id INTEGER NOT NULL REFERENCES desktop_workspace(id) ON DELETE CASCADE,
        agent_id TEXT REFERENCES desktop_agents(id) ON DELETE CASCADE,
        table_name TEXT NOT NULL,
        view_id TEXT NOT NULL,
        PRIMARY KEY(scope_key, table_name),
        CHECK ((scope_key = 'shared' AND agent_id IS NULL) OR (agent_id IS NOT NULL AND scope_key = 'agent:' || agent_id))
    )`)
}

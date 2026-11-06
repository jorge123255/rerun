import 'server-only'
import type { Client } from '@libsql/client'
/** A durable exact source tombstone hides attention, without deleting any transcript. */
export async function withoutStoppedWebhookForms<T extends { id: string }>(db: Client, agentId: string, sessionId: string, messages: T[]): Promise<T[]> {
    const rows = await db.execute({ sql: `SELECT json_extract(source_json,'$.sourceMessageId') AS message_id FROM desktop_trigger_request_links_v1 WHERE agent_id=? AND session_id=? AND phase='stopped'`, args: [agentId,sessionId] })
    const stopped = new Set(rows.rows.map(row=>String(row.message_id)))
    return stopped.size ? messages.filter(message=>!stopped.has(message.id)) : messages
}

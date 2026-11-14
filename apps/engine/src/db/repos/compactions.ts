import { sql } from 'drizzle-orm'
import { desktopCompactionReceiptSchema, type DesktopCompactionReceipt } from '@rerun/contracts'
import { getSystemDb } from '../systemDb.js'
import type { MessageRow } from '../schema.js'

export async function recordDesktopCompaction(agentId: string, sessionId: string, runId: string, userId: string, receipt: DesktopCompactionReceipt) {
    const { client } = await getSystemDb(agentId)
    await client.execute({
        sql: `INSERT INTO desktop_chat_compactions (message_id,run_id,receipt)
              SELECT message.id, run.id, ?
              FROM runs AS run
              JOIN messages AS message ON message.session_id=run.session_id AND message.role='user'
              JOIN sessions AS session ON session.id=run.session_id AND session.agent_id=run.agent_id
              WHERE run.agent_id=? AND run.session_id=? AND run.id=? AND run.status='running' AND message.id=?
                AND NOT EXISTS (SELECT 1 FROM desktop_queued_turns AS queued WHERE queued.run_id=run.id AND queued.message_id<>message.id)
              ON CONFLICT DO NOTHING`,
        args: [JSON.stringify(desktopCompactionReceiptSchema.parse(receipt)), agentId, sessionId, runId, userId],
    })
}

// Used only by the owned Mac history views. No summary or provider message is projected.
export const savedCompactionColumn = (agentId: string) => sql<string | null>`(
    SELECT compaction.receipt
    FROM desktop_chat_compactions AS compaction
    JOIN runs AS run ON run.id=compaction.run_id AND run.session_id=messages.session_id
    WHERE compaction.message_id=messages.id AND messages.role='user' AND run.agent_id=${agentId}
)`

export function withSavedCompaction<T extends MessageRow>({ savedCompaction, ...message }: T & { savedCompaction: string | null }) {
    if (!savedCompaction) return message
    try {
        const receipt = desktopCompactionReceiptSchema.safeParse(JSON.parse(savedCompaction))
        if (receipt.success) return { ...message, desktopCompaction: receipt.data }
    } catch { /* A malformed receipt must not prevent reopening the conversation. */ }
    return message
}

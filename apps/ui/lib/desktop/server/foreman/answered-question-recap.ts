import 'server-only'
import type { Client } from '@libsql/client'
import type { HistoryMessage } from '@/lib/chat/engine-history'
import { projectAnsweredQuestionRecaps, type DesktopAnsweredQuestionRecap } from '@/lib/desktop/foreman/answered-question-recap'

/** Read every saved Foreman answer attempt for this exact chat and keep only the ones the reopened
 * engine transcript proves. The turn rows are local presentation receipts; no guard token leaves
 * this server module, and a missing/ambiguous association yields no recap. */
export async function readAnsweredQuestionRecaps(db: Client, chatId: string, messages: readonly HistoryMessage[]): Promise<DesktopAnsweredQuestionRecap[]> {
    const rows = await db.execute({ sql: 'SELECT body FROM desktop_foreman_turns WHERE chat_id=? ORDER BY created_at,rowid', args: [chatId] })
    return projectAnsweredQuestionRecaps(rows.rows.map(row => row.body), messages)
}

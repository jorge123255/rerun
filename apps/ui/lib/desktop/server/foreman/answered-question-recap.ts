import 'server-only'
import type { Client } from '@libsql/client'
import type { HistoryMessage } from '@/lib/chat/engine-history'
import { projectAnsweredQuestionRecaps, type DesktopAnsweredQuestionRecap } from '@/lib/desktop/foreman/answered-question-recap'

/** Read every saved Foreman answer attempt for this exact chat and keep only the ones the reopened
 * engine transcript proves. The turn rows are local presentation receipts; no guard token leaves
 * this server module, and a missing/ambiguous association yields no recap. */
export async function readAnsweredQuestionRecaps(db: Client, chatId: string, messages: readonly HistoryMessage[]): Promise<DesktopAnsweredQuestionRecap[]> {
    const rows = await db.execute({ sql: "SELECT body FROM desktop_foreman_turns WHERE chat_id=? AND json_valid(body) AND json_extract(body, '$.answerIntent.action') = 'answer' ORDER BY created_at DESC,rowid DESC LIMIT 2048", args: [chatId] })
    const recaps = projectAnsweredQuestionRecaps(rows.rows.map(row => row.body), messages)
    let remaining = 256 * 1024
    return recaps.filter(recap => {
        remaining -= Buffer.byteLength(JSON.stringify(recap))
        return remaining >= 0
    })
}

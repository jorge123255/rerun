import 'server-only'
import type { Client } from '@libsql/client'
import {
    desktopForemanIntakeCompletionReceiptSchema,
    type DesktopForemanChatRef,
    type DesktopForemanPhase,
    type DesktopForemanIntakeAnswers,
    type DesktopForemanIntakeCompletionReceipt,
} from '@rerun/contracts'
import { DesktopHttpError } from '../auth'
import { fingerprintIntakeAnswers } from '../foreman-intake/store'

type ReceiptRow = Record<string, unknown>
const unavailable = () => new DesktopHttpError(503, 'The saved company intake identity could not be confirmed.')

/** The original intake profile closes discover; later plan/build/companion state wins. */
export function desktopForemanIntakePhase(phase: DesktopForemanPhase, profile: DesktopForemanIntakeAnswers | null): DesktopForemanPhase {
    return phase === 'discover' && profile ? 'plan' : phase
}

function receiptOf(row: ReceiptRow, chat: DesktopForemanChatRef): DesktopForemanIntakeCompletionReceipt {
    try {
        const receipt = desktopForemanIntakeCompletionReceiptSchema.parse(JSON.parse(String(row.body)))
        if (String(row.workspace_id) !== chat.workspaceId || String(row.chat_id) !== chat.chatId
            || receipt.chat.workspaceId !== chat.workspaceId || receipt.chat.chatId !== chat.chatId
            || String(row.request_id) !== receipt.requestId || String(row.fingerprint) !== receipt.fingerprint
            || String(row.state) !== receipt.state || String(row.created_at) !== receipt.createdAt || String(row.updated_at) !== receipt.updatedAt
            || fingerprintIntakeAnswers(receipt.answers, receipt.chat, receipt.requestId) !== receipt.fingerprint) throw unavailable()
        return receipt
    } catch { throw unavailable() }
}

/** Exact canonical C receipt, checked against both its SQL identity and its answer digest. */
export async function readDesktopForemanIntakeReceipt(db: Client, chat: DesktopForemanChatRef, requestId: string): Promise<DesktopForemanIntakeCompletionReceipt | null> {
    const row = (await db.execute({
        sql: 'SELECT request_id,workspace_id,chat_id,fingerprint,state,body,created_at,updated_at FROM desktop_foreman_intake_completions WHERE workspace_id=? AND chat_id=? AND request_id=?',
        args: [chat.workspaceId, chat.chatId, requestId],
    })).rows[0]
    return row ? receiptOf(row, chat) : null
}

/**
 * The canonical profile is the accepted C receipt, never a second profile table or draft.
 * The first explicit kickoff may read only its own reserved request while acknowledgement is
 * still pending. Ordinary turns and restored views can read acknowledged answers only.
 */
export async function readDesktopForemanIntakeProfile(db: Client, chat: DesktopForemanChatRef, activeRequestId?: string): Promise<DesktopForemanIntakeAnswers | null> {
    const row = (await db.execute({
        sql: `SELECT request_id,workspace_id,chat_id,fingerprint,state,body,created_at,updated_at FROM desktop_foreman_intake_completions
              WHERE workspace_id=? AND chat_id=? AND (state='acknowledged' OR (request_id=? AND state IN ('pending','uncertain','failed')))
              ORDER BY CASE state WHEN 'acknowledged' THEN 1 ELSE 0 END DESC, updated_at DESC, rowid DESC LIMIT 1`,
        args: [chat.workspaceId, chat.chatId, activeRequestId ?? ''],
    })).rows[0]
    return row ? receiptOf(row, chat).answers : null
}

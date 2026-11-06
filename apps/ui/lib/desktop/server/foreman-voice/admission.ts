import 'server-only'
import type { Client } from '@libsql/client'
import { desktopVoiceDraftSchema } from '@rerun/contracts'
import {
    foremanVoiceTargetSchema, sameForemanVoiceTarget, type ForemanVoiceTarget,
} from '@rerun/contracts'
import { DesktopHttpError } from '../auth'
import type { ForemanTurn } from '../foreman/chat-store'

/** Adds the saved audio cancellation fence to the existing authenticated Foreman admission. */
export async function assertForemanVoiceAdmission(
    db: Client, turn: ForemanTurn, assertOwner: (target: ForemanVoiceTarget) => Promise<void>,
): Promise<void> {
    const id = turn.binding.runId
    const row = (await db.execute({ sql: 'SELECT * FROM desktop_foreman_voice_attempts WHERE attempt_id=?', args: [id] })).rows[0]
    const changed = () => new DesktopHttpError(409, 'This Foreman recording is cancelled or no longer current.')
    if (!row) {
        const cancelled = await db.execute({ sql: 'SELECT 1 FROM desktop_foreman_voice_cancellations WHERE attempt_id=?', args: [id] })
        if (cancelled.rows.length) throw changed()
        return // Existing text turns keep the existing Foreman authority.
    }
    const [workspaceId, chatId, connectionId, model] = JSON.parse(String(row.target))
    const target = foremanVoiceTargetSchema.parse({ chat: { workspaceId, chatId }, model: { connectionId, model } })
    const record = JSON.parse(String(row.record))
    const draft = desktopVoiceDraftSchema.parse(record.draft)
    if (!row.send_requested || row.cancelled || record.deletion || String(row.chat_id) !== chatId
        || !sameForemanVoiceTarget(target, { chat: turn.binding, model: turn.binding.model })
        || draft.attemptId !== id || draft.transcript?.trim() !== turn.text) throw changed()
    await assertOwner(target)
    const fresh = (await db.execute({ sql: 'SELECT epoch,cancelled FROM desktop_foreman_voice_attempts WHERE attempt_id=? AND target=?', args: [id, String(row.target)] })).rows[0]
    if (!fresh || fresh.cancelled || Number(fresh.epoch) !== Number(row.epoch)) throw changed()
}

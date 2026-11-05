import 'server-only'
import { createHash } from 'node:crypto'
import type { Client, Row } from '@libsql/client'
import { BRAIN_UI_MAX_DRAFT_RECORDS, BRAIN_UI_MAX_INTENT_RECORDS, BRAIN_UI_MAX_RECORDS, BRAIN_UI_TOTAL_MAX_BYTES, brainUiKeySchema, brainUiRecordSchema, brainUiWriteSchema, type BrainUiRecord, type BrainUiWrite } from '../../brain-ui-state-schema'
import { DesktopHttpError } from '../auth'

const recordOf = (key: string, row?: Row): BrainUiRecord => brainUiRecordSchema.parse(row
    ? { key, revision: Number(row.revision), value: row.value === null ? null : String(row.value) }
    : { key, revision: 0, value: null })
export class BrainUiConflict extends DesktopHttpError {
    constructor(readonly record: BrainUiRecord) { super(409, 'This saved Brain draft changed in another window. Reopen the Brain before continuing.') }
}
export async function listBrainUiState(db: Client): Promise<{ records: BrainUiRecord[] }> {
    const result = await db.execute({ sql: 'SELECT key,revision,value FROM desktop_brain_ui_state WHERE profile_id=1 AND value IS NOT NULL ORDER BY key LIMIT ?', args: [BRAIN_UI_MAX_RECORDS + 1] })
    if (result.rows.length > BRAIN_UI_MAX_RECORDS) throw new DesktopHttpError(413, 'Too many saved Brain drafts.')
    return { records: result.rows.map(row => recordOf(String(row.key), row)) }
}
/** Cleared records retain their revision for CAS, but are fetched one at a time instead of
 * making renderer hydration grow with every page the user has ever edited. */
export async function readBrainUiRecord(db: Client, key: string): Promise<BrainUiRecord> {
    const parsed = brainUiKeySchema.safeParse(key)
    if (!parsed.success) throw new DesktopHttpError(400, 'Invalid Brain draft identity.')
    const row = (await db.execute({ sql: 'SELECT revision,value FROM desktop_brain_ui_state WHERE profile_id=1 AND key=?', args: [parsed.data] })).rows[0]
    return recordOf(parsed.data, row)
}
export async function writeBrainUiState(db: Client, input: BrainUiWrite): Promise<BrainUiRecord> {
    input = brainUiWriteSchema.parse(input)
    const fingerprint = createHash('sha256').update(JSON.stringify([input.key, input.baseRevision, input.value])).digest('hex')
    const transaction = await db.transaction('write')
    try {
        const found = (await transaction.execute({ sql: 'SELECT revision,value FROM desktop_brain_ui_state WHERE profile_id=1 AND key=?', args: [input.key] })).rows[0]
        const current = recordOf(input.key, found)
        const prior = (await transaction.execute({ sql: 'SELECT fingerprint,key FROM desktop_brain_ui_writes WHERE profile_id=1 AND request_id=?', args: [input.requestId] })).rows[0]
        if (prior) {
            if (prior.fingerprint !== fingerprint || prior.key !== input.key) throw new BrainUiConflict(current)
            await transaction.commit()
            return current
        }
        if (current.revision !== input.baseRevision || current.revision >= Number.MAX_SAFE_INTEGER - 1) throw new BrainUiConflict(current)
        const budget = (await transaction.execute("SELECT COUNT(*) AS count,COALESCE(SUM(CASE WHEN key LIKE 'draft:%' OR key='new-page' THEN 1 ELSE 0 END),0) AS drafts,COALESCE(SUM(length(CAST(value AS BLOB))),0) AS bytes FROM desktop_brain_ui_state WHERE profile_id=1 AND value IS NOT NULL")).rows[0]!
        const bytes = Number(budget.bytes) - Buffer.byteLength(current.value ?? '') + Buffer.byteLength(input.value ?? '')
        const draftKey = input.key.startsWith('draft:') || input.key === 'new-page'
        const groupFull = draftKey ? Number(budget.drafts) >= BRAIN_UI_MAX_DRAFT_RECORDS : Number(budget.count) - Number(budget.drafts) >= BRAIN_UI_MAX_INTENT_RECORDS
        if ((input.value !== null && current.value === null && (Number(budget.count) >= BRAIN_UI_MAX_RECORDS || groupFull)) || bytes > BRAIN_UI_TOTAL_MAX_BYTES) throw new DesktopHttpError(413, 'Saved Brain drafts are full. Finish an existing edit before adding another.')
        const next = { key: input.key, revision: current.revision + 1, value: input.value }
        await transaction.execute({ sql: `INSERT INTO desktop_brain_ui_state(profile_id,key,revision,value) VALUES(1,?,?,?)
            ON CONFLICT(profile_id,key) DO UPDATE SET revision=excluded.revision,value=excluded.value`, args: [next.key, next.revision, next.value] })
        await transaction.execute({ sql: 'INSERT INTO desktop_brain_ui_writes(profile_id,request_id,key,fingerprint) VALUES(1,?,?,?)', args: [input.requestId, input.key, fingerprint] })
        // A pruned retry still cannot apply because its base revision is now stale.
        await transaction.execute({ sql: `DELETE FROM desktop_brain_ui_writes WHERE profile_id=1 AND key=? AND request_id NOT IN
            (SELECT request_id FROM desktop_brain_ui_writes WHERE profile_id=1 AND key=? ORDER BY rowid DESC LIMIT 64)`, args: [input.key, input.key] })
        await transaction.commit()
        return next
    } catch (error) { await transaction.rollback(); throw error } finally { transaction.close() }
}

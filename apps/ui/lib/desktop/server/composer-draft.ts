import 'server-only'
import { createHash } from 'node:crypto'
import { DESKTOP_ATTACHMENT_TOTAL_MAX_BYTES, desktopAttachmentFieldsOf, desktopAttachmentFingerprintOf, desktopAttachmentPathsOf, desktopAttachmentPathsSchema, type DesktopAttachmentFields } from '@rerun/contracts'
import type { Client, Row } from '@libsql/client'
import { desktopComposerDraftSchema, type DesktopComposerDraft, type DesktopComposerDraftClear, type DesktopComposerDraftWrite } from '../composer-draft'
import { DesktopHttpError } from './auth'
import { assertCoworkerNotDeleting } from './coworker-delete'
import { readCoworkerFile } from './coworker-files'
import { openDesktopDatabase } from './database'
import { withRosterWrite } from './roster-writes'
import type { DesktopRuntime } from './runtime'
import { findDesktopAgent, findDesktopSession } from './store'

type Query = Pick<Client, 'execute'>
type Input = DesktopComposerDraftWrite | DesktopComposerDraftClear
const empty = (): DesktopComposerDraft => ({ revision: 0, text: '' })

export class DesktopDraftConflict extends DesktopHttpError {
    constructor(readonly draft: DesktopComposerDraft, message = 'This draft changed in another panel. Review the saved draft before replacing it.') { super(409, message) }
}

// Additive upgrade for installs created before ordered attachment sets. The central schema
// migration carries the same statement; this keeps an un-migrated development database usable.
const attachmentColumn = new WeakMap<Client, Promise<void>>()
function ensureAttachmentColumn(db: Client): Promise<void> {
    const existing = attachmentColumn.get(db)
    if (existing) return existing
    const work = (async () => {
        const columns = await db.execute('PRAGMA table_info(desktop_composer_drafts)')
        if (!columns.rows.some(row => String(row.name) === 'attachment_paths'))
            await db.execute('ALTER TABLE desktop_composer_drafts ADD COLUMN attachment_paths TEXT')
    })().catch(error => { attachmentColumn.delete(db); throw error })
    attachmentColumn.set(db, work)
    return work
}

async function targetOf(db: Client, agentId: string, tabUid: string) {
    await assertCoworkerNotDeleting(db, agentId)
    if (!await findDesktopAgent(db, agentId)) throw new DesktopHttpError(404, 'Coworker not found')
    const found = await db.execute({ sql: `SELECT json_extract(t.value, '$.id') AS session_id
        FROM desktop_agent_tabs a, json_each(a.layout, '$.tabs') t
        WHERE a.agent_id = ? AND json_extract(t.value, '$.uid') = ?`, args: [agentId, tabUid] })
    if (!found.rows.length) throw new DesktopHttpError(404, 'This conversation tab is closed. Reopen it before saving a draft.')
    const sessionId = found.rows[0].session_id
    if (sessionId !== null && (await findDesktopSession(db, String(sessionId)))?.agentId !== agentId) throw new DesktopHttpError(404, 'Conversation not found for this coworker')
}

// `attachment_path` stays the first path for readers that predate ordered sets.
// `attachment_paths` carries the ordered JSON array once more than one file is attached.
function attachmentPathsOfRow(row?: Row): string[] {
    const stored = row?.attachment_paths
    if (stored !== null && stored !== undefined) {
        try {
            const parsed = desktopAttachmentPathsSchema.safeParse(JSON.parse(String(stored)))
            if (parsed.success) return parsed.data
        } catch { /* fall back to the legacy single path */ }
    }
    return row?.attachment_path !== null && row?.attachment_path !== undefined ? [String(row.attachment_path)] : []
}

function draftOf(row?: Row): DesktopComposerDraft {
    if (!row) return empty()
    return desktopComposerDraftSchema.parse({ revision: Number(row.revision), text: String(row.text),
        ...desktopAttachmentFieldsOf(attachmentPathsOfRow(row)), updatedAt: String(row.updated_at) })
}

async function draftAt(db: Query, agentId: string, tabUid: string) {
    const found = await db.execute({ sql: 'SELECT revision, text, attachment_path, attachment_paths, updated_at FROM desktop_composer_drafts WHERE agent_id = ? AND tab_uid = ?', args: [agentId, tabUid] })
    return draftOf(found.rows[0])
}

function fingerprint(agentId: string, input: Input, action: 'save' | 'clear') {
    return createHash('sha256').update(JSON.stringify([action, agentId, input.tabUid, 'baseRevision' in input ? input.baseRevision : input.revision,
        input.text, desktopAttachmentFingerprintOf(desktopAttachmentPathsOf(input))])).digest('hex')
}

export function readDesktopComposerDraft(db: Client, agentId: string, tabUid: string) {
    return withRosterWrite(async () => {
        await ensureAttachmentColumn(db)
        await targetOf(db, agentId, tabUid)
        return { draft: await draftAt(db, agentId, tabUid) }
    })
}

async function mutate(runtime: DesktopRuntime, agentId: string, input: Input, action: 'save' | 'clear', attachmentValidated = false): Promise<{ draft: DesktopComposerDraft; cleared?: boolean } | { validateAttachments: true }> {
    return withRosterWrite(async () => {
        const db = await openDesktopDatabase(runtime.dataRoot)
        await ensureAttachmentColumn(db)
        await targetOf(db, agentId, input.tabUid)
        const transaction = await db.transaction('write')
        try {
            const current = await draftAt(transaction, agentId, input.tabUid)
            const inputPaths = desktopAttachmentPathsOf(input)
            const currentPaths = desktopAttachmentPathsOf(current as DesktopAttachmentFields)
            const hash = fingerprint(agentId, input, action)
            const previous = (await transaction.execute({ sql: 'SELECT agent_id, tab_uid, fingerprint, result_revision, cleared FROM desktop_composer_draft_writes WHERE request_id = ?', args: [input.requestId] })).rows[0]
            if (previous) {
                if (previous.agent_id !== agentId || previous.tab_uid !== input.tabUid || previous.fingerprint !== hash) throw new DesktopDraftConflict(current, 'That draft request was already used for a different change.')
                await transaction.commit()
                // Return the latest state, never the old payload, even if a later edit or fork
                // followed this accepted request before the client recovered its response.
                return { draft: current, ...(action === 'clear' && { cleared: Number(previous.cleared) === 1 && Number(previous.result_revision) === current.revision }) }
            }
            if (action === 'save' && 'baseRevision' in input && input.baseRevision !== current.revision) throw new DesktopDraftConflict(current)
            if (action === 'save' && JSON.stringify(inputPaths) !== JSON.stringify(currentPaths) && !attachmentValidated) return { validateAttachments: true }
            const matches = action === 'clear' && 'revision' in input && input.revision === current.revision && input.text === current.text
                && JSON.stringify(inputPaths) === JSON.stringify(currentPaths)
            const changed = action === 'save' || matches
            if (changed && current.revision >= Number.MAX_SAFE_INTEGER - 1) throw new DesktopDraftConflict(current, 'This draft version cannot be updated. Open a new conversation tab.')
            const next: DesktopComposerDraft = changed
                ? { revision: current.revision + 1, text: action === 'save' ? input.text : '',
                    ...(action === 'save' && desktopAttachmentFieldsOf(inputPaths)), updatedAt: new Date().toISOString() }
                : current
            // Empty rows are revision tombstones. Clear never resets a version to zero, so an
            // older delayed save cannot restore text after a message has been accepted.
            const nextPaths = desktopAttachmentPathsOf(next as DesktopAttachmentFields)
            await transaction.execute({ sql: `INSERT INTO desktop_composer_drafts (agent_id,tab_uid,revision,text,attachment_path,attachment_paths,updated_at) VALUES (?,?,?,?,?,?,?)
                ON CONFLICT(agent_id,tab_uid) DO UPDATE SET revision=excluded.revision, text=excluded.text, attachment_path=excluded.attachment_path, attachment_paths=excluded.attachment_paths, updated_at=excluded.updated_at`,
                args: [agentId, input.tabUid, next.revision, next.text,
                    nextPaths[0] ?? null,
                    nextPaths.length > 1 ? JSON.stringify(nextPaths) : null,
                    next.updatedAt ?? new Date().toISOString()] })
            await transaction.execute({ sql: 'INSERT INTO desktop_composer_draft_writes (request_id,agent_id,tab_uid,fingerprint,result_revision,cleared) VALUES (?,?,?,?,?,?)',
                args: [input.requestId, agentId, input.tabUid, hash, next.revision, matches ? 1 : 0] })
            // Bound acknowledgement metadata. Older identical retries still fail their stale
            // CAS rather than reapplying; the most recent 64 operations can reconcile directly.
            await transaction.execute({ sql: `DELETE FROM desktop_composer_draft_writes WHERE agent_id = ? AND tab_uid = ? AND request_id NOT IN
                (SELECT request_id FROM desktop_composer_draft_writes WHERE agent_id = ? AND tab_uid = ? ORDER BY rowid DESC LIMIT 64)`, args: [agentId, input.tabUid, agentId, input.tabUid] })
            await transaction.commit()
            return { draft: next, ...(action === 'clear' && { cleared: matches }) }
        } finally { transaction.close() }
    })
}

export async function writeDesktopComposerDraft(runtime: DesktopRuntime, agentId: string, input: DesktopComposerDraftWrite) {
    const first = await mutate(runtime, agentId, input, 'save')
    if (!('validateAttachments' in first)) return first
    // Files use the same roster queue; validate ownership and bytes outside the draft
    // transaction, then repeat request identity and CAS checks before committing the set.
    const paths = desktopAttachmentPathsOf(input)
    let total = 0
    for (const path of paths) total += (await readCoworkerFile(runtime, agentId, path, 'attach')).size
    if (total > DESKTOP_ATTACHMENT_TOTAL_MAX_BYTES) throw new DesktopHttpError(413, 'Attachments must be 128 KiB or smaller in total.')
    const result = await mutate(runtime, agentId, input, 'save', true)
    if ('validateAttachments' in result) throw new DesktopHttpError(500, 'Could not save this draft.')
    return result
}

export async function clearDesktopComposerDraft(runtime: DesktopRuntime, agentId: string, input: DesktopComposerDraftClear) {
    const result = await mutate(runtime, agentId, input, 'clear')
    if ('validateAttachments' in result) throw new DesktopHttpError(500, 'Could not clear this draft.')
    return result
}

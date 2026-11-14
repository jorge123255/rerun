import 'server-only'
import type { Client } from '@libsql/client'
import { conversationSearchKey } from '../chat-search'

const VERSION = 42
const ID = 'conversation-search-title'

export async function initializeDesktopRound42(db: Client) {
    const tx = await db.transaction('write')
    try {
        const previous = (await tx.execute({
            sql: 'SELECT id FROM desktop_schema_migrations WHERE version = ?', args: [VERSION],
        })).rows[0]
        if (previous && previous.id !== ID) throw new Error('Desktop migration identity mismatch')
        if (!previous) await tx.execute('ALTER TABLE desktop_sessions ADD COLUMN title_search TEXT')

        // Walk rowids once and bound the backfill batch. A prior app can still write the
        // original schema after upgrade, so also fill missing keys on later opens.
        let after: string | undefined
        for (;;) {
            const rows = (await tx.execute({
                sql: `SELECT CAST(rowid AS TEXT) AS key, title FROM desktop_sessions WHERE title_search IS NULL
                      ${after === undefined ? '' : 'AND rowid > CAST(? AS INTEGER)'} ORDER BY rowid LIMIT 256`,
                args: after === undefined ? [] : [after],
            })).rows
            if (!rows.length) break
            const keys = Object.fromEntries(rows.map(row => [String(row.key), conversationSearchKey(String(row.title))]))
            await tx.execute({
                sql: `UPDATE desktop_sessions SET title_search = titles.value FROM json_each(?) AS titles
                      WHERE desktop_sessions.rowid = CAST(titles.key AS INTEGER)`,
                args: [JSON.stringify(keys)],
            })
            after = String(rows[rows.length - 1].key)
        }

        if (!previous) await tx.execute({
            sql: 'INSERT INTO desktop_schema_migrations(version, id) VALUES (?, ?)', args: [VERSION, ID],
        })
        await tx.commit()
    } catch (error) {
        await tx.rollback()
        throw error
    } finally {
        tx.close()
    }
}

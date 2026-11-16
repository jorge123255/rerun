import 'server-only'
import { createHash } from 'node:crypto'
import type { Client } from '@libsql/client'
import { desktopGithubProjectsRecordSchema, type DesktopForemanChatRef, type DesktopGithubProjectsRecord, type DesktopGithubRepositoryRef } from '@rerun/contracts'

// One row per conversation and set of repository links, like the website read keeps one attempt
// per website. The row marked current is the set in the field now; the others are earlier sets,
// kept so going back to one does not read GitHub again or lose the owner's edits.
export const DESKTOP_GITHUB_PROJECTS_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS desktop_intake_github_projects (
    workspace_id TEXT NOT NULL,
    chat_id TEXT NOT NULL,
    links_key TEXT NOT NULL,
    is_current INTEGER NOT NULL DEFAULT 0,
    body TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY(workspace_id, chat_id, links_key)
);
`

const ready = new WeakMap<Client, Promise<void>>()
/** Created on first use: the table is this feature's own and holds nothing another table refers to. */
export function ensureDesktopGithubProjectsSchema(db: Client): Promise<void> {
    let pending = ready.get(db)
    if (!pending) {
        pending = db.executeMultiple(DESKTOP_GITHUB_PROJECTS_SCHEMA_SQL).then(() => {})
        ready.set(db, pending)
        pending.catch(() => ready.delete(db))
    }
    return pending
}

/** The same set of links gives the same key whatever order or spelling they were typed in. */
export function desktopGithubLinksKey(repositories: readonly Pick<DesktopGithubRepositoryRef, 'id'>[]): string {
    return createHash('sha256').update(JSON.stringify(repositories.map(repository => repository.id).sort())).digest('hex')
}

function recordOf(row: Record<string, unknown> | undefined): DesktopGithubProjectsRecord | null {
    if (!row) return null
    try {
        const parsed = desktopGithubProjectsRecordSchema.safeParse(JSON.parse(String(row.body)))
        // A row that does not read back as what was saved is left out rather than trusted.
        return parsed.success && parsed.data.key === String(row.links_key) ? parsed.data : null
    } catch { return null }
}

export function createDesktopGithubProjectsStore(db: Client) {
    const where = 'workspace_id=? AND chat_id=?'
    const of = (chat: DesktopForemanChatRef) => [chat.workspaceId, chat.chatId]
    return {
        async current(chat: DesktopForemanChatRef): Promise<DesktopGithubProjectsRecord | null> {
            await ensureDesktopGithubProjectsSchema(db)
            return recordOf((await db.execute({ sql: `SELECT links_key,body FROM desktop_intake_github_projects WHERE ${where} AND is_current=1 ORDER BY updated_at DESC LIMIT 1`, args: of(chat) })).rows[0])
        },
        async byKey(chat: DesktopForemanChatRef, key: string): Promise<DesktopGithubProjectsRecord | null> {
            await ensureDesktopGithubProjectsSchema(db)
            return recordOf((await db.execute({ sql: `SELECT links_key,body FROM desktop_intake_github_projects WHERE ${where} AND links_key=?`, args: [...of(chat), key] })).rows[0])
        },
        /** Saves the record and makes it the current set for this conversation. */
        async save(chat: DesktopForemanChatRef, record: DesktopGithubProjectsRecord): Promise<void> {
            await ensureDesktopGithubProjectsSchema(db)
            const checked = desktopGithubProjectsRecordSchema.parse(record)
            await db.batch([
                { sql: `UPDATE desktop_intake_github_projects SET is_current=0 WHERE ${where} AND links_key<>?`, args: [...of(chat), checked.key] },
                {
                    sql: `INSERT INTO desktop_intake_github_projects(workspace_id,chat_id,links_key,is_current,body,created_at,updated_at) VALUES(?,?,?,1,?,?,?)
                          ON CONFLICT(workspace_id,chat_id,links_key) DO UPDATE SET is_current=1, body=excluded.body, updated_at=excluded.updated_at`,
                    args: [...of(chat), checked.key, JSON.stringify(checked), checked.readAt, checked.updatedAt],
                },
            ], 'write')
        },
        /** The field was emptied: no set is current, and nothing is passed on. */
        async clear(chat: DesktopForemanChatRef): Promise<void> {
            await ensureDesktopGithubProjectsSchema(db)
            await db.execute({ sql: `UPDATE desktop_intake_github_projects SET is_current=0 WHERE ${where}`, args: of(chat) })
        },
    }
}
export type DesktopGithubProjectsStore = ReturnType<typeof createDesktopGithubProjectsStore>

/** The current projects of a conversation, for the Chief of Staff's instructions. Never throws. */
export async function readDesktopGithubProjects(db: Client, chat: DesktopForemanChatRef): Promise<DesktopGithubProjectsRecord | null> {
    try { return await createDesktopGithubProjectsStore(db).current(chat) } catch { return null }
}

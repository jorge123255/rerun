import 'server-only'
import type { Client } from '@libsql/client'
import { desktopMcpBrowserApprovalSchema } from './mcp-sign-in/browser-approval'

const BROWSER_APPROVAL = { version: 38, id: 'mcp-browser-attempt-approval' }

export async function initializeDesktopRound39(db: Client) {
    const tx = await db.transaction('write')
    try {
        const { version, id } = BROWSER_APPROVAL
        const previous = (await tx.execute({ sql: 'SELECT id FROM desktop_schema_migrations WHERE version=?', args: [version] })).rows[0]
        if (previous && previous.id !== id) throw new Error('Desktop migration identity mismatch')
        if (!previous) {
            await tx.execute(desktopMcpBrowserApprovalSchema)
            await tx.execute({ sql: 'INSERT INTO desktop_schema_migrations(version,id) VALUES(?,?)', args: [version, id] })
        }
        await tx.commit()
    } catch (error) {
        await tx.rollback()
        throw error
    } finally { tx.close() }
}

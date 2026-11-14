import 'server-only'
import type { Client } from '@libsql/client'
import { desktopMcpDeviceReviewSchema } from './mcp-device-approval/store'
import { desktopMcpMethodAdmissionSchema } from './mcp-method-admission/contract'

const METHOD_ADMISSION = { version: 39, id: 'mcp-method-admission' }

export async function initializeDesktopRound40(db: Client) {
    const tx = await db.transaction('write')
    try {
        const { version, id } = METHOD_ADMISSION
        const previous = (await tx.execute({ sql: 'SELECT id FROM desktop_schema_migrations WHERE version=?', args: [version] })).rows[0]
        if (previous && previous.id !== id) throw new Error('Desktop migration identity mismatch')
        if (!previous) {
            await tx.execute(desktopMcpDeviceReviewSchema)
            await tx.executeMultiple(desktopMcpMethodAdmissionSchema)
            await tx.execute({ sql: 'INSERT INTO desktop_schema_migrations(version,id) VALUES(?,?)', args: [version, id] })
        }
        await tx.commit()
    } catch (error) {
        await tx.rollback()
        throw error
    } finally { tx.close() }
}

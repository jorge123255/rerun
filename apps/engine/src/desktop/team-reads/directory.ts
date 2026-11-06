import { createClient, type Client } from '@libsql/client'
import { join } from 'node:path'
import {
    DESKTOP_TEAM_DIRECTORY_CALLER_SQL,
    DESKTOP_TEAM_DIRECTORY_LOOKUP_SQL,
    DESKTOP_TEAM_DIRECTORY_MEMBER_SQL,
} from '../../../../../packages/contracts/src/desktop-team-reads.ts'
import type { DesktopTeamDirectory, DesktopTeamMember } from './ports.js'

function openDesktopCatalog(): Client | null {
    const root = process.env.RERUN_DESKTOP_DATA_DIR
    if (!root) return null
    return createClient({ url: `file:${join(root, 'app.db')}` })
}

function memberOf(row: Record<string, unknown>): DesktopTeamMember {
    const engineAgentId = row.engine_agent_id == null ? '' : String(row.engine_agent_id)
    return {
        publicId: String(row.id),
        engineAgentId,
        name: String(row.name ?? ''),
        handle: row.handle == null ? null : String(row.handle),
        spaceId: row.space_id == null ? null : String(row.space_id),
        enabled: Number(row.enabled) === 1,
        configured: engineAgentId.length > 0,
        deleting: Number(row.deleting) === 1,
    }
}

/** Reads the existing desktop catalog. A missing data directory is not an empty team. */
export function desktopTeamDirectory(): DesktopTeamDirectory {
    return {
        async caller(engineAgentId) {
            const db = openDesktopCatalog()
            if (!db) return null
            try {
                const rows = await db.execute({ sql: DESKTOP_TEAM_DIRECTORY_CALLER_SQL, args: [engineAgentId] })
                if (rows.rows.length !== 1) return rows.rows.length > 1 ? 'uncertain' : null
                const row = rows.rows[0]
                if (!row || row.engine_agent_id == null) return null
                return { workspaceId: String(row.workspace_id), publicId: String(row.id), engineAgentId: String(row.engine_agent_id) }
            } catch {
                return 'uncertain'
            } finally {
                db.close()
            }
        },
        async members(workspaceId) {
            const db = openDesktopCatalog()
            const id = Number(workspaceId)
            if (!db || !Number.isSafeInteger(id) || id < 1) return { acknowledgement: 'uncertain' }
            try {
                const rows = await db.execute({ sql: DESKTOP_TEAM_DIRECTORY_MEMBER_SQL, args: [id] })
                return { acknowledgement: 'ready', value: rows.rows.map(row => memberOf(row as Record<string, unknown>)) }
            } catch {
                return { acknowledgement: 'uncertain' }
            } finally {
                db.close()
            }
        },
        async lookup(workspaceId, agentId) {
            const db = openDesktopCatalog()
            if (!db) return { kind: 'uncertain' }
            try {
                const rows = await db.execute({ sql: DESKTOP_TEAM_DIRECTORY_LOOKUP_SQL, args: [agentId, agentId] })
                if (rows.rows.length === 0) return { kind: 'missing' }
                if (rows.rows.length !== 1) return { kind: 'uncertain' }
                const row = rows.rows[0] as Record<string, unknown>
                if (String(row.workspace_id) !== String(workspaceId)) return { kind: 'other-workspace' }
                return { kind: 'member', member: memberOf(row) }
            } catch {
                return { kind: 'uncertain' }
            } finally {
                db.close()
            }
        },
    }
}

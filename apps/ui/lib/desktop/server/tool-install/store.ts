import 'server-only'

import type { Client } from '@libsql/client'
import {
    desktopToolInstallSnapshotSchema,
    type DesktopToolInstallPackage,
    type DesktopToolInstallRunIdentity,
    type DesktopToolInstallSnapshot,
} from '@rerun/contracts'
import { desktopToolInstallSchema } from './schema'

export function desktopToolInstallStore(db: Client) {
    async function initialize() {
        await db.execute(desktopToolInstallSchema)
    }

    async function read(operationId: string): Promise<DesktopToolInstallSnapshot | null> {
        await initialize()
        const row = (await db.execute({ sql: 'SELECT snapshot FROM desktop_tool_installs WHERE operation_id = ?', args: [operationId] })).rows[0]
        return row && String(row.snapshot) !== 'null' ? desktopToolInstallSnapshotSchema.parse(JSON.parse(String(row.snapshot))) : null
    }

    function assertIdentity(snapshot: DesktopToolInstallSnapshot, identity: DesktopToolInstallRunIdentity, packages: DesktopToolInstallPackage[]): void {
        if (snapshot.agentId !== identity.agentId || snapshot.sessionId !== identity.sessionId || snapshot.runId !== identity.runId || snapshot.toolCallId !== identity.toolCallId || snapshot.proposalRevision !== identity.proposalRevision) throw new Error('Installation identity conflict')
        if (snapshot.packages.length !== packages.length || snapshot.packages.some((item, index) => item.package !== packages[index])) throw new Error('Installation package conflict')
    }

    return {
        read,

        async list(sessionId: string): Promise<DesktopToolInstallSnapshot[]> {
            await initialize()
            const rows = (await db.execute({ sql: 'SELECT snapshot FROM desktop_tool_installs', args: [] })).rows
            return rows.flatMap(row => {
                if (String(row.snapshot) === 'null') return []
                const snapshot = desktopToolInstallSnapshotSchema.parse(JSON.parse(String(row.snapshot)))
                return snapshot.sessionId === sessionId ? [snapshot] : []
            }).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.operationId.localeCompare(b.operationId))
        },

        async begin(identity: DesktopToolInstallRunIdentity, operationId: string, packages: DesktopToolInstallPackage[]): Promise<'execute' | DesktopToolInstallSnapshot> {
            await initialize()
            const tx = await db.transaction('write')
            try {
                const row = (await tx.execute({ sql: 'SELECT identity,snapshot FROM desktop_tool_installs WHERE operation_id = ?', args: [operationId] })).rows[0]
                if (row) {
                    const storedIdentity = JSON.parse(String(row.identity)) as DesktopToolInstallRunIdentity
                    if (JSON.stringify(storedIdentity) !== JSON.stringify(identity)) throw new Error('Installation identity conflict')
                    if (String(row.snapshot) === 'null') {
                        await tx.commit()
                        return 'execute'
                    }
                    const previous = desktopToolInstallSnapshotSchema.parse(JSON.parse(String(row.snapshot)))
                    assertIdentity(previous, identity, packages)
                    await tx.commit()
                    return previous
                }
                await tx.execute({ sql: 'INSERT INTO desktop_tool_installs(operation_id,identity,snapshot,created_at,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(operation_id) DO NOTHING', args: [operationId, JSON.stringify(identity), 'null', new Date().toISOString(), new Date().toISOString()] })
                await tx.commit()
                return 'execute'
            } finally { tx.close() }
        },

        async complete(identity: DesktopToolInstallRunIdentity, snapshot: DesktopToolInstallSnapshot): Promise<void> {
            await initialize()
            const packages = snapshot.packages.map(item => item.package)
            assertIdentity(snapshot, identity, packages)
            const row = (await db.execute({ sql: 'SELECT identity,snapshot FROM desktop_tool_installs WHERE operation_id = ?', args: [snapshot.operationId] })).rows[0]
            if (!row) throw new Error('Installation reservation is missing')
            const storedIdentity = JSON.parse(String(row.identity)) as DesktopToolInstallRunIdentity
            if (JSON.stringify(storedIdentity) !== JSON.stringify(identity)) throw new Error('Installation identity conflict')
            const current = String(row.snapshot) === 'null' ? null : desktopToolInstallSnapshotSchema.parse(JSON.parse(String(row.snapshot)))
            if (current && Number(current.revision) >= Number(snapshot.revision)) throw new Error('Installation completion conflict')
            await db.execute({ sql: 'UPDATE desktop_tool_installs SET identity=?,snapshot=?,updated_at=? WHERE operation_id=?', args: [JSON.stringify(identity), JSON.stringify(snapshot), snapshot.updatedAt, snapshot.operationId] })
        },
    }
}

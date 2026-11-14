import 'server-only'
import { createHash } from 'node:crypto'
import { redactDesktopMcpSecretValue } from '@rerun/contracts'
import { desktopVaultProgramCredentialLimit, desktopVaultProgramValue, desktopVaultProgramVariable } from '../../vault'
import type { DesktopSecretCrypto, DesktopSecretEncryptionContext } from '../secret-requests/crypto'
import { emptyMcpMaterialLease, type DesktopMcpMaterialSource } from '../mcp-secret-references/lease'
import type { Client } from '@libsql/client'
import { stdioInput, type StdioConnection } from '../mcp-stdio/store'

async function assignedPrograms(db: Client, owner: string, name?: string) {
    const { rows } = await db.execute({
        sql: `SELECT p.id,p.name,p.executable,p.args,p.revision,p.executable_identity
            FROM desktop_vault_mcp_programs p
            JOIN desktop_agents a ON a.id=? AND a.workspace_id=1
            WHERE (p.shared_with_all=1 OR EXISTS (
                SELECT 1 FROM desktop_vault_mcp_program_attachments t WHERE t.item_id=p.id AND t.agent_id=a.id
            ))
            AND (? IS NULL OR p.name=?)
            AND NOT EXISTS (SELECT 1 FROM desktop_deletions d WHERE d.agent_id=a.id OR d.engine_agent_id=a.engine_agent_id)
            AND NOT EXISTS (SELECT 1 FROM desktop_remote_mcp r WHERE r.agent_id=a.id AND r.name=p.name)
            AND NOT EXISTS (SELECT 1 FROM desktop_mcp_stdio s WHERE s.owner=a.id AND s.name=p.name)
            ORDER BY p.name LIMIT 17`,
        args: [owner, name ?? null, name ?? null],
    })
    return rows
}

export async function assignedVaultMcpPrograms(db: Client, owner: string): Promise<StdioConnection[]> {
    return (await assignedPrograms(db, owner)).map(row => {
        if (typeof row.executable_identity !== 'string' || !row.executable_identity) throw new Error('Local Vault program is missing executable approval')
        const revision = String(row.revision)
        return {
            ...stdioInput.parse({ name: row.name, executable: row.executable, args: JSON.parse(String(row.args)), revision }),
            revision, transport: 'stdio', approvedExecutable: row.executable_identity,
        }
    })
}

export function vaultProgramCredentialContext(workspaceId: number, item: { id: string; executable: string; approvedExecutable: string; args: string }, name: string, revision: string): DesktopSecretEncryptionContext {
    const configuration = createHash('sha256').update(JSON.stringify([item.executable, item.approvedExecutable, item.args])).digest('hex')
    return { domain: 'vault', workspaceId, agentId: item.id, key: JSON.stringify(['program-env', configuration, name]), version: 1, revision }
}

export function vaultProgramMaterials(db: Client, crypto: DesktopSecretCrypto, workspaceId: number): DesktopMcpMaterialSource {
    return async (owner, name, revision, _phase, signal) => {
        const current = async () => {
            signal.throwIfAborted()
            const [row] = await assignedPrograms(db, owner, name)
            signal.throwIfAborted()
            if (row?.revision !== revision) throw new Error('Vault local program changed')
            return row
        }
        const item = await current()
        const rows = (await db.execute({
            sql: `SELECT c.name,c.credential_revision,c.sealed
                  FROM desktop_vault_mcp_program_credentials c JOIN desktop_vault_mcp_programs p ON p.id=c.item_id
                  WHERE p.id=? AND p.revision=? ORDER BY c.name LIMIT ?`,
            args: [String(item.id), revision, desktopVaultProgramCredentialLimit + 1],
        })).rows
        if (rows.length > desktopVaultProgramCredentialLimit) throw new Error('Too many Vault program credentials')
        const lease = emptyMcpMaterialLease()
        lease.check = async () => { await current() }
        const bytes: Uint8Array[] = []
        lease.release = async () => {
            for (const value of bytes) value.fill(0)
            for (const key of Object.keys(lease.material.env)) delete lease.material.env[key]
        }
        try {
            for (const row of rows) {
                signal.throwIfAborted()
                const variable = desktopVaultProgramVariable.parse(row.name)
                const context = vaultProgramCredentialContext(workspaceId, {
                    id: String(item.id), executable: String(item.executable), approvedExecutable: String(item.executable_identity), args: String(item.args),
                }, variable, String(row.credential_revision))
                const raw = await crypto.open(context, String(row.sealed))
                bytes.push(raw)
                lease.material.env[variable] = desktopVaultProgramValue.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw))
            }
            await lease.check()
            lease.protect = result => redactDesktopMcpSecretValue(result, bytes)
            return lease
        } catch (error) {
            await lease.release()
            throw error
        }
    }
}

import 'server-only'
import { createHash } from 'node:crypto'
import type { Client } from '@libsql/client'
import {
    desktopMcpSecretBindingSchema,
    desktopMcpSecretReferenceCanonical,
    desktopMcpSecretReferencePlan,
    desktopMcpSecretReferencePublicConfig,
    desktopMcpSecretReferencePublicIssue,
    desktopMcpCredentialAuthoritySchema,
    desktopMcpSecretReferenceSaveResultSchema,
    desktopMcpSecretReferenceSaveSchema,
    type DesktopMcpSecretBinding,
    type DesktopMcpSecretReferenceAuthority,
    type DesktopMcpSecretReferenceConfig,
    type DesktopMcpSecretReferenceSave,
    type DesktopMcpSecretReferenceSaveResult,
} from '@rerun/contracts'

export class DesktopMcpSecretReferenceConflict extends Error {
    readonly code = 'conflict' as const
    constructor(message = 'The MCP configuration changed. Refresh before saving again.') {
        super(message)
        this.name = 'DesktopMcpSecretReferenceConflict'
    }
}

export type DesktopMcpSecretReferenceExecutor = {
    execute(statement: { sql: string; args?: Array<string | number | null> }): Promise<{ rows: ReadonlyArray<Record<string, unknown>>; rowsAffected: number }>
}

export type DesktopMcpPublicConfigPort = {
    commit(input: {
        agentId: string
        serverName: string
        expectedConfigRevision: string
        config: DesktopMcpSecretReferenceConfig
        tx: DesktopMcpSecretReferenceExecutor
    }): Promise<{ configRevision: string }>
}

type Head = {
    configRevision: string
    bindingRevision: number
    origin: string
    fingerprint: string
    authority: DesktopMcpSecretReferenceSaveResult['authority']
    publicJson: string
}

const fingerprintOf = (config: DesktopMcpSecretReferenceConfig) => createHash('sha256').update(desktopMcpSecretReferenceCanonical(config)).digest('hex')

const notSaved = (save: Pick<DesktopMcpSecretReferenceSave, 'saveId' | 'agentId' | 'serverName' | 'expectedConfigRevision' | 'expectedBindingRevision'>, message: string): DesktopMcpSecretReferenceSaveResult => ({
    status: 'not-saved',
    saveId: save.saveId,
    agentId: save.agentId,
    serverName: save.serverName,
    configRevision: save.expectedConfigRevision,
    bindingRevision: save.expectedBindingRevision,
    authority: 'anonymous',
    pending: [],
    bound: [],
    message,
})

function replayed(stored: DesktopMcpSecretReferenceSaveResult): DesktopMcpSecretReferenceSaveResult {
    if (stored.status === 'not-saved' || stored.status === 'conflict') return stored
    const storedStatus = stored.status === 'saved' || stored.status === 'pending' ? stored.status : stored.storedStatus
    return desktopMcpSecretReferenceSaveResultSchema.parse({ ...stored, status: 'replayed', ...(storedStatus ? { storedStatus } : {}) })
}

async function readHead(tx: DesktopMcpSecretReferenceExecutor, agentId: string, serverName: string): Promise<Head | null> {
    const row = (await tx.execute({
        sql: `SELECT config_revision, binding_revision, origin, fingerprint, authority, public_json
              FROM desktop_mcp_secret_reference_heads WHERE agent_id = ? AND server_name = ?`,
        args: [agentId, serverName],
    })).rows[0]
    if (!row) return null
    return {
        configRevision: String(row.config_revision),
        bindingRevision: Number(row.binding_revision),
        origin: String(row.origin),
        fingerprint: String(row.fingerprint),
        authority: desktopMcpCredentialAuthoritySchema.parse(String(row.authority)),
        publicJson: String(row.public_json),
    }
}

function sameAttempt(row: Record<string, unknown>, save: DesktopMcpSecretReferenceSave): boolean {
    return String(row.agent_id) === save.agentId
        && String(row.server_name) === save.serverName
        && String(row.origin) === save.origin
        && String(row.body_fingerprint) === save.fingerprint
        && String(row.expected_config_revision) === save.expectedConfigRevision
        && Number(row.expected_binding_revision) === save.expectedBindingRevision
}

export function createDesktopMcpSecretReferenceStore(db: Client, ports: {
    authority: DesktopMcpSecretReferenceAuthority
    captureAuthority: (agentId: string) => Promise<() => void>
    commitPublicConfig: DesktopMcpPublicConfigPort['commit']
    readVersion?: (executor: DesktopMcpSecretReferenceExecutor, agentId: string, key: string) => Promise<number | undefined>
}) {
    const readVersion = ports.readVersion ?? (async (executor, agentId, key) => {
        const row = (await executor.execute({
            sql: 'SELECT version FROM desktop_secret_credentials WHERE agent_id = ? AND key = ?', args: [agentId, key],
        })).rows[0]
        return row ? Number(row.version) : undefined
    })
    return {
        async reconcile(input: DesktopMcpSecretReferenceSave): Promise<DesktopMcpSecretReferenceSaveResult> {
            const save = desktopMcpSecretReferenceSaveSchema.parse(input)
            const check = await ports.captureAuthority(save.agentId)
            check()
            const tx = await db.transaction('write')
            try {
                const row = (await tx.execute({ sql: 'SELECT * FROM desktop_mcp_secret_reference_saves WHERE save_id=?', args: [save.saveId] })).rows[0]
                if (row) {
                    if (!sameAttempt(row, save)) throw new DesktopMcpSecretReferenceConflict('This save does not match the previous attempt.')
                    const result = desktopMcpSecretReferenceSaveResultSchema.parse(JSON.parse(String(row.result_json)))
                    await tx.rollback()
                    return result.status === 'not-saved' ? result : replayed(result)
                }
                const result = notSaved(save, 'This attempt was not applied and can no longer be submitted.')
                await tx.execute({ sql: `INSERT INTO desktop_mcp_secret_reference_saves (save_id,agent_id,server_name,expected_config_revision,expected_binding_revision,origin,body_fingerprint,result_json,created_at) VALUES(?,?,?,?,?,?,?,?,?)`, args: [save.saveId, save.agentId, save.serverName, save.expectedConfigRevision, save.expectedBindingRevision, save.origin, save.fingerprint, JSON.stringify(result), new Date().toISOString()] })
                check(); await tx.commit()
                return result
            } catch (error) { await tx.rollback().catch(() => {}); throw error }
            finally { tx.close() }
        },
        async receipt(agentId: string, saveId: string): Promise<DesktopMcpSecretReferenceSaveResult | null> {
            const row = (await db.execute({ sql: 'SELECT agent_id,result_json FROM desktop_mcp_secret_reference_saves WHERE save_id=?', args: [saveId] })).rows[0]
            if (!row) return null
            if (String(row.agent_id) !== agentId) throw new DesktopMcpSecretReferenceConflict('This save belongs to another coworker.')
            return replayed(desktopMcpSecretReferenceSaveResultSchema.parse(JSON.parse(String(row.result_json))))
        },
        async head(agentId: string, serverName: string): Promise<Head | null> {
            return readHead(db, agentId, serverName)
        },

        async bindings(agentId: string, serverName: string): Promise<DesktopMcpSecretBinding[]> {
            const result = await db.execute({
                sql: `SELECT agent_id, server_name, config_revision, binding_revision, field, field_key, secret_name, secret_version, status, origin
                      FROM desktop_mcp_secret_references WHERE agent_id = ? AND server_name = ? ORDER BY field, field_key`,
                args: [agentId, serverName],
            })
            return result.rows.map(row => desktopMcpSecretBindingSchema.parse({
                agentId: String(row.agent_id),
                serverName: String(row.server_name),
                configRevision: String(row.config_revision),
                bindingRevision: Number(row.binding_revision),
                field: String(row.field),
                fieldKey: String(row.field_key),
                secretName: String(row.secret_name),
                secretVersion: row.secret_version === null ? null : Number(row.secret_version),
                status: String(row.status),
                origin: String(row.origin),
            }))
        },

        async serversForSecret(agentId: string, secretName: string): Promise<string[]> {
            const result = await db.execute({
                sql: 'SELECT DISTINCT server_name FROM desktop_mcp_secret_references WHERE agent_id = ? AND secret_name = ? ORDER BY server_name',
                args: [agentId, secretName],
            })
            return result.rows.map(row => String(row.server_name))
        },

        async markStale(agentId: string, serverName: string, secretName: string): Promise<void> {
            await db.execute({
                sql: `UPDATE desktop_mcp_secret_references
                      SET status = 'pending', secret_version = NULL, updated_at = ?
                      WHERE agent_id = ? AND server_name = ? AND secret_name = ? AND status = 'bound'`,
                args: [new Date().toISOString(), agentId, serverName, secretName],
            })
        },

        async save(input: DesktopMcpSecretReferenceSave): Promise<DesktopMcpSecretReferenceSaveResult> {
            const parsed = desktopMcpSecretReferenceSaveSchema.safeParse(input)
            if (!parsed.success) return notSaved({ saveId: 'rejected', agentId: 'rejected', serverName: 'rejected', expectedConfigRevision: '0', expectedBindingRevision: 0 }, 'The credential reference save is not valid.')
            const save = parsed.data
            const issue = desktopMcpSecretReferencePublicIssue(save.config)
            if (issue) return notSaved(save, issue)
            const config = desktopMcpSecretReferencePublicConfig(save.config)
            const plan = config ? desktopMcpSecretReferencePlan(config) : null
            if (!config || !plan || config.name !== save.serverName) return notSaved(save, 'The MCP server description is not valid.')
            if (fingerprintOf(config) !== save.fingerprint) return notSaved(save, 'Fingerprint does not match the public configuration.')
            const owner = await ports.authority.currentOwner(save.agentId)
            if (!owner || owner.agentId !== save.agentId || !owner.enabled || owner.deleting) return notSaved(save, 'Credential is not available to this coworker.')

            const check = await ports.captureAuthority(save.agentId)
            check()
            const tx = await db.transaction('write')
            const executor: DesktopMcpSecretReferenceExecutor = {
                execute: statement => tx.execute(statement),
            }
            try {
                check()
                const existing = (await executor.execute({ sql: 'SELECT * FROM desktop_mcp_secret_reference_saves WHERE save_id = ?', args: [save.saveId] })).rows[0]
                if (existing) {
                    if (!sameAttempt(existing, save)) {
                        await tx.rollback()
                        return { ...notSaved(save, 'This save does not match the previous attempt.'), status: 'conflict' }
                    }
                    const stored = desktopMcpSecretReferenceSaveResultSchema.parse(JSON.parse(String(existing.result_json)))
                    await tx.rollback()
                    return replayed(stored)
                }
                const head = await readHead(executor, save.agentId, save.serverName)
                if ((head?.bindingRevision ?? 0) !== save.expectedBindingRevision) {
                    await tx.rollback()
                    return { ...notSaved(save, 'The credential binding changed. Refresh before saving again.'), status: 'conflict' }
                }
                const committed = await ports.commitPublicConfig({
                    agentId: save.agentId,
                    serverName: save.serverName,
                    expectedConfigRevision: save.expectedConfigRevision,
                    config,
                    tx: executor,
                })
                check()
                if (typeof committed.configRevision !== 'string' || !committed.configRevision || committed.configRevision.length > 200) throw new DesktopMcpSecretReferenceConflict()
                const names = [...new Set(plan.references.map(reference => reference.name))]
                const versions = new Map<string, number>()
                for (const name of names) {
                    const version = await readVersion(executor, save.agentId, name)
                    if (version !== undefined) versions.set(name, version)
                }
                const now = new Date().toISOString()
                const bindingRevision = save.expectedBindingRevision + 1
                await executor.execute({ sql: 'DELETE FROM desktop_mcp_secret_references WHERE agent_id = ? AND server_name = ?', args: [save.agentId, save.serverName] })
                for (const reference of plan.references) {
                    const version = versions.get(reference.name)
                    await executor.execute({
                        sql: `INSERT INTO desktop_mcp_secret_references
                              (agent_id, server_name, config_revision, binding_revision, field, field_key, secret_name, secret_version, status, origin, updated_at)
                              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                        args: [save.agentId, save.serverName, committed.configRevision, bindingRevision, reference.field, reference.key, reference.name, version ?? null, version === undefined ? 'pending' : 'bound', save.origin, now],
                    })
                }
                const pending = names.filter(name => !versions.has(name))
                const bound = names.filter(name => versions.has(name)).map(name => ({ name, version: versions.get(name)! }))
                const result = desktopMcpSecretReferenceSaveResultSchema.parse({
                    status: pending.length > 0 ? 'pending' : 'saved',
                    saveId: save.saveId,
                    agentId: save.agentId,
                    serverName: save.serverName,
                    configRevision: committed.configRevision,
                    bindingRevision,
                    authority: plan.authority,
                    pending,
                    bound,
                    message: pending.length > 0
                        ? 'Missing credentials stay pending. The MCP server was not accepted.'
                        : plan.references.length > 0
                            ? 'Credential references are bound. The MCP server was not accepted.'
                            : 'No credential references. Existing bearer, OAuth, or anonymous settings stay in MCP server settings.',
                })
                const written = await executor.execute({
                    sql: `INSERT INTO desktop_mcp_secret_reference_heads
                          (agent_id, server_name, config_revision, binding_revision, origin, fingerprint, authority, public_json, updated_at)
                          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                          ON CONFLICT(agent_id, server_name) DO UPDATE SET
                            config_revision = excluded.config_revision,
                            binding_revision = excluded.binding_revision,
                            origin = excluded.origin,
                            fingerprint = excluded.fingerprint,
                            authority = excluded.authority,
                            public_json = excluded.public_json,
                            updated_at = excluded.updated_at
                          WHERE desktop_mcp_secret_reference_heads.binding_revision = ?`,
                    args: [save.agentId, save.serverName, committed.configRevision, bindingRevision, save.origin, save.fingerprint, plan.authority, desktopMcpSecretReferenceCanonical(config), now, save.expectedBindingRevision],
                })
                if (Number(written.rowsAffected) !== 1) throw new DesktopMcpSecretReferenceConflict()
                await executor.execute({
                    sql: `INSERT INTO desktop_mcp_secret_reference_saves
                          (save_id, agent_id, server_name, expected_config_revision, expected_binding_revision, origin, body_fingerprint, result_json, created_at)
                          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                    args: [save.saveId, save.agentId, save.serverName, save.expectedConfigRevision, save.expectedBindingRevision, save.origin, save.fingerprint, JSON.stringify(result), now],
                })
                check()
                await tx.commit()
                return result
            } catch (error) {
                await tx.rollback().catch(() => undefined)
                if (error instanceof DesktopMcpSecretReferenceConflict) return { ...notSaved(save, error.message), status: 'conflict' }
                return notSaved(save, 'The credential reference save could not be recorded.')
            } finally {
                tx.close()
            }
        },
    }
}

export type DesktopMcpSecretReferenceStore = ReturnType<typeof createDesktopMcpSecretReferenceStore>

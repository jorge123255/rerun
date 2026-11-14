import 'server-only'

import { createHash } from 'node:crypto'
import { desktopMcpSecretReferenceCanonical, desktopMcpSecretReferencePlan, desktopMcpSecretReferencePublicConfig } from '@rerun/contracts'
import type { DesktopMcpSecretReferenceExecutor } from './store'
import { readDesktopMcpCredentialVersion } from '../vault/mcp-credentials'

/** Used inside the proposal's existing config+effect transaction, never as a second save. */
export async function adoptDesktopMcpReferences(tx: DesktopMcpSecretReferenceExecutor, input: { agentId: string; serverName: string; configRevision: string; origin: string; config: unknown; check(): void }) {
    const config = desktopMcpSecretReferencePublicConfig(input.config), plan = config && desktopMcpSecretReferencePlan(config)
    if (!config || !plan || config.name !== input.serverName) throw new Error('The reviewed credential references are invalid')
    input.check()
    const prior = (await tx.execute({ sql: 'SELECT binding_revision FROM desktop_mcp_secret_reference_heads WHERE agent_id=? AND server_name=?', args: [input.agentId, input.serverName] })).rows[0]
    const bindingRevision = Number(prior?.binding_revision ?? 0) + 1, now = new Date().toISOString()
    const versions = new Map<string, number>()
    const names = [...new Set(plan.references.map(reference => reference.name))]
    for (const key of names) {
        const version = await readDesktopMcpCredentialVersion(tx, input.agentId, key)
        if (version !== undefined) versions.set(key, version)
    }
    await tx.execute({ sql: 'DELETE FROM desktop_mcp_secret_references WHERE agent_id=? AND server_name=?', args: [input.agentId, input.serverName] })
    for (const reference of plan.references) {
        const version = versions.get(reference.name)
        await tx.execute({ sql: `INSERT INTO desktop_mcp_secret_references(agent_id,server_name,config_revision,binding_revision,field,field_key,secret_name,secret_version,status,origin,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)`, args: [input.agentId, input.serverName, input.configRevision, bindingRevision, reference.field, reference.key, reference.name, version ?? null, version === undefined ? 'pending' : 'bound', input.origin, now] })
    }
    const canonical = desktopMcpSecretReferenceCanonical(config), fingerprint = createHash('sha256').update(canonical).digest('hex')
    await tx.execute({ sql: `INSERT INTO desktop_mcp_secret_reference_heads(agent_id,server_name,config_revision,binding_revision,origin,fingerprint,authority,public_json,updated_at) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(agent_id,server_name) DO UPDATE SET config_revision=excluded.config_revision,binding_revision=excluded.binding_revision,origin=excluded.origin,fingerprint=excluded.fingerprint,authority=excluded.authority,public_json=excluded.public_json,updated_at=excluded.updated_at`, args: [input.agentId, input.serverName, input.configRevision, bindingRevision, input.origin, fingerprint, plan.authority, canonical, now] })
    input.check()
    return { pending: names.filter(name => !versions.has(name)), bound: names.filter(name => versions.has(name)).map(name => ({ name, version: versions.get(name)! })) }
}

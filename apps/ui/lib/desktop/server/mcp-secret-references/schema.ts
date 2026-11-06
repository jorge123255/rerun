import 'server-only'
import type { Client } from '@libsql/client'

export const desktopMcpSecretReferenceSchema = `
CREATE TABLE IF NOT EXISTS desktop_mcp_secret_reference_heads (
    agent_id TEXT NOT NULL REFERENCES desktop_agents(id) ON DELETE CASCADE,
    server_name TEXT NOT NULL,
    config_revision INTEGER NOT NULL,
    binding_revision INTEGER NOT NULL,
    origin TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    authority TEXT NOT NULL CHECK (authority IN ('reference', 'literal', 'oauth', 'anonymous')),
    public_json TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (agent_id, server_name)
);
CREATE TABLE IF NOT EXISTS desktop_mcp_secret_references (
    agent_id TEXT NOT NULL REFERENCES desktop_agents(id) ON DELETE CASCADE,
    server_name TEXT NOT NULL,
    config_revision INTEGER NOT NULL,
    binding_revision INTEGER NOT NULL,
    field TEXT NOT NULL CHECK (field IN ('header', 'env', 'arg')),
    field_key TEXT NOT NULL,
    secret_name TEXT NOT NULL,
    secret_version INTEGER,
    status TEXT NOT NULL CHECK (status IN ('pending', 'bound')),
    origin TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (agent_id, server_name, field, field_key)
);
CREATE TABLE IF NOT EXISTS desktop_mcp_secret_reference_saves (
    save_id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL REFERENCES desktop_agents(id) ON DELETE CASCADE,
    server_name TEXT NOT NULL,
    expected_config_revision INTEGER NOT NULL,
    expected_binding_revision INTEGER NOT NULL,
    origin TEXT NOT NULL,
    body_fingerprint TEXT NOT NULL,
    result_json TEXT NOT NULL,
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS desktop_mcp_secret_references_secret
    ON desktop_mcp_secret_references (agent_id, secret_name);
`

const initialized = new WeakMap<Client, Promise<void>>()

export function ensureDesktopMcpSecretReferenceSchema(db: Client): Promise<void> {
    let work = initialized.get(db)
    if (!work) {
        work = (async () => {
            const tx = await db.transaction('write')
            try {
                await tx.executeMultiple(desktopMcpSecretReferenceSchema)
                await tx.commit()
            } catch (error) {
                await tx.rollback().catch(() => undefined)
                throw error
            } finally {
                tx.close()
            }
        })()
        initialized.set(db, work)
        void work.catch(() => { if (initialized.get(db) === work) initialized.delete(db) })
    }
    return work
}

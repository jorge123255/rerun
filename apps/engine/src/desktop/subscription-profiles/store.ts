import type { DesktopSubscriptionCredentialGeneration, DesktopSubscriptionProfileProvider } from './contract.js'

export type SubscriptionProfileRow = {
    workspaceId: number
    profileId: string
    provider: DesktopSubscriptionProfileProvider
    displayName: string
    connectionId: 'mac-chatgpt' | 'mac-claude' | null
    credentialGeneration: DesktopSubscriptionCredentialGeneration | null
    explicit: boolean
    availability: 'current-session' | 'unavailable'
    createdAt: string
    updatedAt: string
}

export type SubscriptionRunBinding = {
    workspaceId: number
    ownerId: string
    agentId: string
    provider: DesktopSubscriptionProfileProvider
    profileId: string
    connectionId: 'mac-chatgpt' | 'mac-claude'
    credentialGeneration: DesktopSubscriptionCredentialGeneration
    runId: string
    sessionId: string
    capturedAt: string
}

export type SubscriptionReceiptRow = {
    workspaceId: number
    requestId: string
    kind: 'name' | 'select' | 'remove' | 'capture' | 'generation'
    publicBody: string
    status: 'saved' | 'refused' | 'uncertain'
    profileId: string | null
    credentialGeneration: string | null
    message: string
    createdAt: string
}

export type SubscriptionProfileStore = {
    profiles(workspaceId: number): Promise<SubscriptionProfileRow[]>
    putProfile(row: SubscriptionProfileRow): Promise<void>
    deleteProfile(workspaceId: number, profileId: string): Promise<void>
    receipt(workspaceId: number, requestId: string): Promise<SubscriptionReceiptRow | null>
    putReceipt(row: SubscriptionReceiptRow): Promise<void>
    binding(workspaceId: number, runId: string): Promise<SubscriptionRunBinding | null>
    bindingsForProfile(workspaceId: number, profileId: string): Promise<SubscriptionRunBinding[]>
    putBinding(row: SubscriptionRunBinding): Promise<void>
}

type SqlClient = { execute(query: { sql: string; args?: unknown[] }): Promise<{ rows: Array<Record<string, unknown>> }> }

const MISSING = 'Subscription profile store is not installed.'

function installed(error: unknown): never {
    const message = error instanceof Error ? error.message : ''
    if (/no such table/i.test(message)) throw new Error(MISSING)
    throw error
}

function generation(value: unknown): DesktopSubscriptionCredentialGeneration | null {
    return typeof value === 'string' ? value as DesktopSubscriptionCredentialGeneration : null
}

export function sqliteSubscriptionProfileStore(db: SqlClient): SubscriptionProfileStore {
    const run = async (sql: string, args: unknown[] = []) => {
        try { return await db.execute({ sql, args }) } catch (error) { installed(error) }
    }
    return {
        async profiles(workspaceId) {
            const result = await run('SELECT * FROM desktop_subscription_profiles WHERE workspace_id=? ORDER BY profile_id', [workspaceId])
            return result.rows.map(row => ({
                workspaceId: Number(row.workspace_id), profileId: String(row.profile_id), provider: String(row.provider) as DesktopSubscriptionProfileProvider,
                displayName: String(row.display_name), connectionId: row.connection_id ? String(row.connection_id) as 'mac-chatgpt' | 'mac-claude' : null,
                credentialGeneration: generation(row.credential_generation), explicit: Number(row.explicit_selection) === 1,
                availability: String(row.availability) as 'current-session' | 'unavailable', createdAt: String(row.created_at), updatedAt: String(row.updated_at),
            }))
        },
        async putProfile(row) {
            await run(`INSERT INTO desktop_subscription_profiles(workspace_id,profile_id,provider,display_name,connection_id,credential_generation,explicit_selection,availability,created_at,updated_at)
                VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(workspace_id,profile_id) DO UPDATE SET display_name=excluded.display_name, connection_id=excluded.connection_id,
                credential_generation=excluded.credential_generation, explicit_selection=excluded.explicit_selection, availability=excluded.availability, updated_at=excluded.updated_at`,
            [row.workspaceId, row.profileId, row.provider, row.displayName, row.connectionId, row.credentialGeneration, row.explicit ? 1 : 0, row.availability, row.createdAt, row.updatedAt])
        },
        async deleteProfile(workspaceId, profileId) { await run('DELETE FROM desktop_subscription_profiles WHERE workspace_id=? AND profile_id=?', [workspaceId, profileId]) },
        async receipt(workspaceId, requestId) {
            const result = await run('SELECT * FROM desktop_subscription_profile_receipts WHERE workspace_id=? AND request_id=?', [workspaceId, requestId])
            const row = result.rows[0]
            if (!row) return null
            return { workspaceId, requestId, kind: String(row.kind) as SubscriptionReceiptRow['kind'], publicBody: String(row.public_body), status: String(row.status) as SubscriptionReceiptRow['status'], profileId: row.profile_id ? String(row.profile_id) : null, credentialGeneration: generation(row.credential_generation), message: String(row.message), createdAt: String(row.created_at) }
        },
        async putReceipt(row) {
            await run(`INSERT INTO desktop_subscription_profile_receipts(workspace_id,request_id,kind,public_body,status,profile_id,credential_generation,message,created_at)
                VALUES(?,?,?,?,?,?,?,?,?)`, [row.workspaceId, row.requestId, row.kind, row.publicBody, row.status, row.profileId, row.credentialGeneration, row.message, row.createdAt])
        },
        async binding(workspaceId, runId) {
            const result = await run('SELECT * FROM desktop_subscription_profile_runs WHERE workspace_id=? AND run_id=?', [workspaceId, runId])
            const row = result.rows[0]
            return row ? bindingOf(row) : null
        },
        async bindingsForProfile(workspaceId, profileId) {
            const result = await run('SELECT * FROM desktop_subscription_profile_runs WHERE workspace_id=? AND profile_id=?', [workspaceId, profileId])
            return result.rows.map(bindingOf)
        },
        async putBinding(row) {
            await run(`INSERT INTO desktop_subscription_profile_runs(workspace_id,run_id,owner_id,agent_id,provider,profile_id,connection_id,credential_generation,session_id,captured_at)
                VALUES(?,?,?,?,?,?,?,?,?,?)`, [row.workspaceId, row.runId, row.ownerId, row.agentId, row.provider, row.profileId, row.connectionId, row.credentialGeneration, row.sessionId, row.capturedAt])
        },
    }
}

function bindingOf(row: Record<string, unknown>): SubscriptionRunBinding {
    return {
        workspaceId: Number(row.workspace_id), ownerId: String(row.owner_id), agentId: String(row.agent_id), provider: String(row.provider) as DesktopSubscriptionProfileProvider,
        profileId: String(row.profile_id), connectionId: String(row.connection_id) as 'mac-chatgpt' | 'mac-claude', credentialGeneration: String(row.credential_generation) as DesktopSubscriptionCredentialGeneration,
        runId: String(row.run_id), sessionId: String(row.session_id), capturedAt: String(row.captured_at),
    }
}

export const SUBSCRIPTION_PROFILE_DDL = `
CREATE TABLE desktop_subscription_profiles (
    workspace_id INTEGER NOT NULL,
    profile_id TEXT NOT NULL,
    provider TEXT NOT NULL,
    display_name TEXT NOT NULL,
    connection_id TEXT,
    credential_generation TEXT,
    explicit_selection INTEGER NOT NULL DEFAULT 0,
    availability TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (workspace_id, profile_id)
);
CREATE TABLE desktop_subscription_profile_runs (
    workspace_id INTEGER NOT NULL,
    run_id TEXT NOT NULL,
    owner_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    provider TEXT NOT NULL,
    profile_id TEXT NOT NULL,
    connection_id TEXT NOT NULL,
    credential_generation TEXT NOT NULL,
    session_id TEXT NOT NULL,
    captured_at TEXT NOT NULL,
    PRIMARY KEY (workspace_id, run_id)
);
CREATE TABLE desktop_subscription_profile_receipts (
    workspace_id INTEGER NOT NULL,
    request_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    public_body TEXT NOT NULL,
    status TEXT NOT NULL,
    profile_id TEXT,
    credential_generation TEXT,
    message TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (workspace_id, request_id)
);`

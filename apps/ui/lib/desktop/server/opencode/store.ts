import type { Client } from '@libsql/client'
import type { DesktopOpencodeRefresh, DesktopOpencodeResult, DesktopOpencodeWindow } from '@rerun/contracts'

// Root appends this SQL at the next free desktop_schema_migrations version.
// Recommended id: opencode-go-console-receipts. Do not reuse versions 25–30.
// Version 30 is already foreman-company-intake, and workspaces/schema.ts also proposes 30.
// Round 36 recommended 31 for shared-file receipts and is not in this base. Use 32 when 31 is taken, otherwise 31.
export const DESKTOP_OPENCODE_SCHEMA_ID = 'opencode-go-console-receipts'
export const DESKTOP_OPENCODE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS desktop_opencode_catalog (
 workspace_id INTEGER PRIMARY KEY,
 request_id TEXT NOT NULL,
 revision TEXT NOT NULL,
 source TEXT NOT NULL CHECK(source IN ('live','cached','snapshot')),
 fresh INTEGER NOT NULL CHECK(fresh IN (0,1)),
 captured_at TEXT,
 unavailable_reason TEXT,
 selected_model_id TEXT NOT NULL,
 selected_preserved INTEGER NOT NULL CHECK(selected_preserved IN (0,1)),
 retired_json TEXT NOT NULL,
 models_json TEXT NOT NULL,
 updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS desktop_opencode_calls (
 workspace_id INTEGER NOT NULL,
 connection_id TEXT NOT NULL,
 run_id TEXT NOT NULL,
 request_id TEXT NOT NULL,
 digest TEXT NOT NULL,
 phase TEXT NOT NULL CHECK(phase IN ('claimed','terminal')),
 result_json TEXT,
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL,
 PRIMARY KEY (workspace_id, connection_id, run_id, request_id)
);
CREATE TABLE IF NOT EXISTS desktop_opencode_limits (
 workspace_id INTEGER NOT NULL,
 connection_id TEXT NOT NULL,
 captured_at TEXT NOT NULL,
 windows_json TEXT NOT NULL,
 PRIMARY KEY (workspace_id, connection_id)
);`

export type DesktopOpencodeCallKey = { workspaceId: number; connectionId: string; runId: string; requestId: string }

export type DesktopOpencodeCallRecord = DesktopOpencodeCallKey & {
    digest: string
    phase: 'claimed' | 'terminal'
    result: DesktopOpencodeResult | null
    createdAt: string
    updatedAt: string
}

export type DesktopOpencodeLimitsRecord = { windows: DesktopOpencodeWindow[]; capturedAt: string }

export type DesktopOpencodeStore = {
    readCall(key: DesktopOpencodeCallKey): Promise<DesktopOpencodeCallRecord | null>
    claim(row: DesktopOpencodeCallRecord): Promise<{ inserted: boolean; row: DesktopOpencodeCallRecord }>
    finish(key: DesktopOpencodeCallKey, digest: string, result: DesktopOpencodeResult, at: string): Promise<void>
    readCatalog(workspaceId: number): Promise<DesktopOpencodeRefresh | null>
    saveCatalog(refresh: DesktopOpencodeRefresh, at: string): Promise<void>
    readLimits(workspaceId: number, connectionId: string): Promise<DesktopOpencodeLimitsRecord | null>
    saveLimits(workspaceId: number, connectionId: string, record: DesktopOpencodeLimitsRecord): Promise<void>
    forgetLimits(workspaceId: number, connectionId: string): Promise<void>
}

export class DesktopOpencodeStoreError extends Error {
    constructor(message: string) {
        super(message)
        this.name = 'DesktopOpencodeStoreError'
    }
}

const callKey = (key: DesktopOpencodeCallKey) => `${key.workspaceId}\0${key.connectionId}\0${key.runId}\0${key.requestId}`

export function memoryDesktopOpencodeStore(): DesktopOpencodeStore {
    const calls = new Map<string, DesktopOpencodeCallRecord>()
    const catalogs = new Map<number, DesktopOpencodeRefresh>()
    const limits = new Map<string, DesktopOpencodeLimitsRecord>()
    return {
        async readCall(key) { return calls.get(callKey(key)) ?? null },
        async claim(row) {
            const name = callKey(row)
            const existing = calls.get(name)
            if (existing) {
                if (existing.digest !== row.digest) throw new DesktopOpencodeStoreError('Tool call identity was reused')
                return { inserted: false, row: existing }
            }
            calls.set(name, row)
            return { inserted: true, row }
        },
        async finish(key, digest, result, at) {
            const existing = calls.get(callKey(key))
            if (!existing || existing.digest !== digest) throw new DesktopOpencodeStoreError('Tool call identity was reused')
            if (existing.result) return
            existing.phase = 'terminal'
            existing.result = result
            existing.updatedAt = at
        },
        async readCatalog(workspaceId) { return catalogs.get(workspaceId) ?? null },
        async saveCatalog(refresh, _at) { catalogs.set(refresh.workspaceId, refresh) },
        async readLimits(workspaceId, connectionId) { return limits.get(`${workspaceId}\0${connectionId}`) ?? null },
        async saveLimits(workspaceId, connectionId, record) { limits.set(`${workspaceId}\0${connectionId}`, record) },
        async forgetLimits(workspaceId, connectionId) { limits.delete(`${workspaceId}\0${connectionId}`) },
    }
}

function refreshFrom(row: Record<string, unknown>): DesktopOpencodeRefresh {
    return {
        workspaceId: Number(row.workspace_id),
        requestId: String(row.request_id),
        revision: String(row.revision),
        source: row.source as DesktopOpencodeRefresh['source'],
        fresh: Number(row.fresh) === 1,
        capturedAt: row.captured_at == null ? null : String(row.captured_at),
        ...(row.unavailable_reason == null ? {} : { unavailableReason: String(row.unavailable_reason) }),
        selectedModelId: String(row.selected_model_id),
        selectedPreserved: Number(row.selected_preserved) === 1,
        retiredModelIds: JSON.parse(String(row.retired_json)) as string[],
        models: JSON.parse(String(row.models_json)) as DesktopOpencodeRefresh['models'],
    }
}

// Assumes DESKTOP_OPENCODE_SCHEMA_SQL was applied by the root migration. This function does not create tables.
export function sqliteDesktopOpencodeStore(db: Client): DesktopOpencodeStore {
    return {
        async readCall(key) {
            const row = (await db.execute({ sql: 'SELECT * FROM desktop_opencode_calls WHERE workspace_id=? AND connection_id=? AND run_id=? AND request_id=?', args: [key.workspaceId, key.connectionId, key.runId, key.requestId] })).rows[0]
            if (!row) return null
            return { ...key, digest: String(row.digest), phase: row.phase === 'terminal' ? 'terminal' : 'claimed', result: row.result_json == null ? null : JSON.parse(String(row.result_json)) as DesktopOpencodeResult, createdAt: String(row.created_at), updatedAt: String(row.updated_at) }
        },
        async claim(row) {
            const inserted = await db.execute({ sql: 'INSERT INTO desktop_opencode_calls(workspace_id,connection_id,run_id,request_id,digest,phase,result_json,created_at,updated_at) VALUES(?,?,?,?,?,?,NULL,?,?) ON CONFLICT DO NOTHING', args: [row.workspaceId, row.connectionId, row.runId, row.requestId, row.digest, 'claimed', row.createdAt, row.updatedAt] })
            const existing = await this.readCall(row)
            if (!existing || existing.digest !== row.digest) throw new DesktopOpencodeStoreError('Tool call identity was reused')
            return { inserted: inserted.rowsAffected === 1, row: inserted.rowsAffected === 1 ? row : existing }
        },
        async finish(key, digest, result, at) {
            const existing = await this.readCall(key)
            if (!existing || existing.digest !== digest) throw new DesktopOpencodeStoreError('Tool call identity was reused')
            if (existing.result) return
            await db.execute({ sql: `UPDATE desktop_opencode_calls SET phase='terminal', result_json=?, updated_at=? WHERE workspace_id=? AND connection_id=? AND run_id=? AND request_id=? AND digest=? AND result_json IS NULL`, args: [JSON.stringify(result), at, key.workspaceId, key.connectionId, key.runId, key.requestId, digest] })
        },
        async readCatalog(workspaceId) {
            const row = (await db.execute({ sql: 'SELECT * FROM desktop_opencode_catalog WHERE workspace_id=?', args: [workspaceId] })).rows[0]
            return row ? refreshFrom(row as Record<string, unknown>) : null
        },
        async saveCatalog(refresh, at) {
            await db.execute({ sql: `INSERT INTO desktop_opencode_catalog(workspace_id,request_id,revision,source,fresh,captured_at,unavailable_reason,selected_model_id,selected_preserved,retired_json,models_json,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(workspace_id) DO UPDATE SET request_id=excluded.request_id, revision=excluded.revision, source=excluded.source, fresh=excluded.fresh, captured_at=excluded.captured_at, unavailable_reason=excluded.unavailable_reason, selected_model_id=excluded.selected_model_id, selected_preserved=excluded.selected_preserved, retired_json=excluded.retired_json, models_json=excluded.models_json, updated_at=excluded.updated_at`, args: [refresh.workspaceId, refresh.requestId, refresh.revision, refresh.source, refresh.fresh ? 1 : 0, refresh.capturedAt, refresh.unavailableReason ?? null, refresh.selectedModelId, refresh.selectedPreserved ? 1 : 0, JSON.stringify(refresh.retiredModelIds), JSON.stringify(refresh.models), at] })
        },
        async readLimits(workspaceId, connectionId) {
            const row = (await db.execute({ sql: 'SELECT captured_at, windows_json FROM desktop_opencode_limits WHERE workspace_id=? AND connection_id=?', args: [workspaceId, connectionId] })).rows[0]
            return row ? { capturedAt: String(row.captured_at), windows: JSON.parse(String(row.windows_json)) as DesktopOpencodeWindow[] } : null
        },
        async saveLimits(workspaceId, connectionId, record) {
            await db.execute({ sql: `INSERT INTO desktop_opencode_limits(workspace_id,connection_id,captured_at,windows_json) VALUES(?,?,?,?) ON CONFLICT(workspace_id, connection_id) DO UPDATE SET captured_at=excluded.captured_at, windows_json=excluded.windows_json`, args: [workspaceId, connectionId, record.capturedAt, JSON.stringify(record.windows)] })
        },
        async forgetLimits(workspaceId, connectionId) {
            await db.execute({ sql: 'DELETE FROM desktop_opencode_limits WHERE workspace_id=? AND connection_id=?', args: [workspaceId, connectionId] })
        },
    }
}

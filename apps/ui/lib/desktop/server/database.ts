import 'server-only'
import { mkdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createClient, type Client } from '@libsql/client'

const opening = new Map<string, Promise<Client>>()

async function initialize(dataRoot: string): Promise<Client> {
    await mkdir(dataRoot, { recursive: true, mode: 0o700 })
    const client = createClient({ url: `file:${join(dataRoot, 'app.db')}` })
    await client.executeMultiple(`
        PRAGMA journal_mode = WAL;
        PRAGMA foreign_keys = ON;
        PRAGMA busy_timeout = 5000;

        CREATE TABLE IF NOT EXISTS desktop_profile (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            display_name TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS desktop_workspace (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            profile_id INTEGER NOT NULL REFERENCES desktop_profile(id),
            name TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS desktop_appearance (
            workspace_id INTEGER PRIMARY KEY REFERENCES desktop_workspace(id),
            theme TEXT NOT NULL CHECK (theme IN ('system', 'light', 'dark'))
        );
        CREATE TABLE IF NOT EXISTS desktop_agents (
            id TEXT PRIMARY KEY,
            workspace_id INTEGER NOT NULL REFERENCES desktop_workspace(id),
            engine_agent_id TEXT NOT NULL UNIQUE,
            name TEXT NOT NULL,
            description TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS desktop_sessions (
            id TEXT PRIMARY KEY,
            agent_id TEXT NOT NULL REFERENCES desktop_agents(id) ON DELETE CASCADE,
            engine_session_id TEXT NOT NULL UNIQUE,
            title TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        PRAGMA user_version = 1;
    `)
    const now = new Date().toISOString()
    await client.batch([
        { sql: 'INSERT OR IGNORE INTO desktop_profile (id, display_name, created_at, updated_at) VALUES (1, ?, ?, ?)', args: ['Local User', now, now] },
        { sql: 'INSERT OR IGNORE INTO desktop_workspace (id, profile_id, name, created_at, updated_at) VALUES (1, 1, ?, ?, ?)', args: ['My workspace', now, now] },
    ], 'write')
    return client
}

export async function openDesktopDatabase(dataRoot: string): Promise<Client> {
    const key = resolve(dataRoot)
    const existing = opening.get(key)
    if (existing) return existing
    const promise = initialize(key).catch(error => {
        opening.delete(key)
        throw error
    })
    opening.set(key, promise)
    return promise
}

export async function closeDesktopDatabase(dataRoot: string): Promise<void> {
    const key = resolve(dataRoot)
    const promise = opening.get(key)
    if (!promise) return
    opening.delete(key)
    const client = await promise
    client.close()
}

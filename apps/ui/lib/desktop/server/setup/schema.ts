import 'server-only'
import type { Client } from '@libsql/client'

const INITIALIZING = Symbol.for('rerun.desktop.setup.schema.v1')
const initializing = () => ((globalThis as unknown as Record<symbol, WeakMap<Client, Promise<void>>>)[INITIALIZING] ??= new WeakMap())

export function ensureDesktopSetupSchema(db: Client): Promise<void> {
    const prior = initializing().get(db)
    if (prior) return prior
    // Central database opening calls this before exposing the connection. Later route reads
    // share its promise instead of running DDL (and executeMultiple) over an active transaction.
    const pending = initialize(db)
    initializing().set(db, pending)
    void pending.catch(() => { if (initializing().get(db) === pending) initializing().delete(db) })
    return pending
}

async function initialize(db: Client): Promise<void> {
    await db.executeMultiple(`
        CREATE TABLE IF NOT EXISTS desktop_setup_state (
            agent_id TEXT PRIMARY KEY REFERENCES desktop_agents(id) ON DELETE CASCADE,
            skipped INTEGER NOT NULL DEFAULT 0,
            updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS desktop_setup_intents (
            request_id TEXT PRIMARY KEY,
            agent_id TEXT NOT NULL REFERENCES desktop_agents(id) ON DELETE CASCADE,
            action TEXT NOT NULL,
            fingerprint TEXT NOT NULL,
            intent TEXT NOT NULL,
            status TEXT NOT NULL CHECK(status IN ('pending','complete','rejected')),
            result TEXT,
            created_at TEXT NOT NULL
        );
        CREATE UNIQUE INDEX IF NOT EXISTS desktop_setup_one_pending
            ON desktop_setup_intents(agent_id) WHERE status='pending';
        CREATE TABLE IF NOT EXISTS desktop_setup_kickoffs (
            agent_id TEXT NOT NULL REFERENCES desktop_agents(id) ON DELETE CASCADE,
            engine_session_id TEXT NOT NULL,
            run_id TEXT NOT NULL UNIQUE,
            prompt TEXT NOT NULL,
            status TEXT NOT NULL CHECK(status IN ('reserved','admitted','existing')),
            PRIMARY KEY(agent_id,engine_session_id)
        );
        CREATE TABLE IF NOT EXISTS desktop_setup_events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            agent_id TEXT NOT NULL,
            kind TEXT NOT NULL,
            detail TEXT,
            created_at TEXT NOT NULL
        );
    `)
}

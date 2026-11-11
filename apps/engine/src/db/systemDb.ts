import { DESKTOP_GUEST_SHELL_SCHEMA_SQL } from '../desktop/guest-shell/schema.js'
import { DESKTOP_TRIGGER_HUMAN_SQL } from '../desktop/triggers/human-schema.js'
import { DESKTOP_SCHEDULE_TOOL_SCHEMA_SQL } from '../desktop/schedule-tools/schema.js'
import { desktopTriggerStateSchema } from '../desktop/triggers/state.js'
import { mkdirSync, existsSync } from 'node:fs'
import { createClient, type Client } from '@libsql/client'
import { drizzle, type LibSQLDatabase } from 'drizzle-orm/libsql'
import { agentDataDir, systemDbPath } from '../config/paths.js'
import { sessions, messages, runs, runSteps, toolCalls, compactionCheckpoints, skillProposals } from './schema.js'
import { latestVersion, migrateSqlite, type SqliteMigration } from './ladder.js'
import { beginDesktopAgentWork } from '../desktop/agent-lifecycle.js'
import { desktopApp } from '../desktop/policy.js'
import { FOREMAN_AGENT_ID } from '@rerun/contracts'

const schema = { sessions, messages, runs, runSteps, toolCalls, compactionCheckpoints, skillProposals }

export type SystemDb = { client: Client; db: LibSQLDatabase<typeof schema> }

const SYSTEM_DDL = `
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    title TEXT NOT NULL DEFAULT 'Untitled',
    status TEXT NOT NULL DEFAULT 'open',
    source TEXT NOT NULL DEFAULT 'dashboard',
    origin_agent_id TEXT,
    origin_session_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_agent_idx ON sessions(agent_id);
CREATE INDEX IF NOT EXISTS sessions_origin_agent_idx ON sessions(origin_agent_id);

CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    role TEXT NOT NULL,
    content_json TEXT NOT NULL,
    tool_calls_json TEXT,
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_session_idx ON messages(session_id);

CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(content, message_id UNINDEXED);

CREATE TABLE IF NOT EXISTS memories (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    path TEXT NOT NULL,
    content TEXT NOT NULL,
    embedding F32_BLOB(1536),
    kind TEXT NOT NULL DEFAULT 'note',
    created_at TEXT NOT NULL,
    last_accessed_at TEXT,
    access_count INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS memories_agent_idx ON memories(agent_id);
CREATE INDEX IF NOT EXISTS memories_vec_idx ON memories(libsql_vector_idx(embedding));

CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(content, memory_id UNINDEXED);

CREATE TABLE IF NOT EXISTS runs (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'running',
    step_count INTEGER NOT NULL DEFAULT 0,
    usage_json TEXT,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    error TEXT
);
CREATE INDEX IF NOT EXISTS runs_agent_idx ON runs(agent_id);
CREATE INDEX IF NOT EXISTS runs_agent_started_idx ON runs(agent_id, started_at);
CREATE INDEX IF NOT EXISTS runs_session_started_idx ON runs(session_id, started_at);

CREATE TABLE IF NOT EXISTS run_steps (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    step_number INTEGER NOT NULL,
    provider TEXT,
    model TEXT,
    finish_reason TEXT,
    input_tokens INTEGER,
    output_tokens INTEGER,
    cached_input_tokens INTEGER,
    reasoning_tokens INTEGER,
    total_tokens INTEGER,
    tool_call_count INTEGER NOT NULL DEFAULT 0,
    text_length INTEGER NOT NULL DEFAULT 0,
    duration_ms INTEGER,
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS run_steps_run_idx ON run_steps(run_id);

CREATE TABLE IF NOT EXISTS tool_calls (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    step_number INTEGER NOT NULL,
    tool_call_id TEXT,
    tool_name TEXT NOT NULL,
    input_json TEXT,
    result_json TEXT,
    is_error INTEGER NOT NULL DEFAULT 0,
    duration_ms INTEGER,
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS tool_calls_run_idx ON tool_calls(run_id);
CREATE INDEX IF NOT EXISTS tool_calls_name_idx ON tool_calls(tool_name);

CREATE TABLE IF NOT EXISTS compaction_checkpoints (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    summary_json TEXT NOT NULL,
    through_message_id TEXT NOT NULL,
    through_created_at TEXT NOT NULL,
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS compaction_checkpoints_session_idx ON compaction_checkpoints(session_id);

CREATE TABLE IF NOT EXISTS skill_proposals (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    run_id TEXT,
    tool_call_id TEXT NOT NULL,
    mode TEXT NOT NULL,
    slug TEXT,
    title TEXT NOT NULL,
    summary TEXT NOT NULL,
    instructions_json TEXT NOT NULL,
    fingerprints_json TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'proposed',
    applied_slug TEXT,
    error TEXT,
    created_at TEXT NOT NULL,
    decided_at TEXT,
    connection_id TEXT,
    provider TEXT,
    model TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS skill_proposals_tool_call_idx ON skill_proposals(tool_call_id);
CREATE INDEX IF NOT EXISTS skill_proposals_session_idx ON skill_proposals(session_id);
CREATE INDEX IF NOT EXISTS skill_proposals_agent_idx ON skill_proposals(agent_id);
`

const pool = new Map<string, SystemDb>()
const opening = new Map<string, Promise<SystemDb>>()

async function ensureSessionSourceColumn(client: Client): Promise<void> {
    const info = await client.execute("PRAGMA table_info('sessions')")
    const hasSource = info.rows.some(row => row.name === 'source')
    if (hasSource) return
    await client.execute("ALTER TABLE sessions ADD COLUMN source TEXT NOT NULL DEFAULT 'dashboard'")
    await client.executeMultiple(`
        UPDATE sessions SET source = 'schedule' WHERE source = 'dashboard' AND title LIKE 'schedule: %';
        UPDATE sessions SET source = 'delegate' WHERE source = 'dashboard' AND title LIKE 'delegated: %';
        UPDATE sessions SET source = 'agent' WHERE source = 'dashboard' AND title LIKE 'from %';
    `)
}

async function ensureColumns(client: Client, table: string, columns: string[]): Promise<void> {
    const info = await client.execute(`PRAGMA table_info('${table}')`)
    const existing = new Set(info.rows.map(row => row.name))
    for (const column of columns) {
        const name = column.split(' ')[0]
        if (existing.has(name)) continue
        await client.execute(`ALTER TABLE ${table} ADD COLUMN ${column}`)
    }
}

const RUN_TELEMETRY_COLUMNS = [
    'provider TEXT',
    'model TEXT',
    'trigger_source TEXT',
    'trigger_slug TEXT',
    'cost_micros INTEGER',
    'input_tokens INTEGER',
    'output_tokens INTEGER',
    'cached_input_tokens INTEGER',
    'reasoning_tokens INTEGER',
    'total_tokens INTEGER',
]

const MEMORY_DECAY_COLUMNS = ['last_accessed_at TEXT', 'access_count INTEGER NOT NULL DEFAULT 0']

// The pair the proposing conversation ran on, so the writing job bills the same subscription.
const SKILL_PROPOSAL_MODEL_COLUMNS = ['connection_id TEXT', 'provider TEXT', 'model TEXT']

const MESSAGE_AUTHOR_COLUMNS = ['author_id TEXT', 'author_name TEXT']

// What a step wrote into the prompt cache and what it cost: the two numbers that tell whether a
// turn reused the one before it, which the run row cannot say.
const RUN_STEP_CACHE_COST_COLUMNS = ['cache_write_tokens INTEGER', 'cost_micros INTEGER']

// A schema change is a new step at the end, never an edit to a shipped one: see `db/ladder.ts`.
export const SYSTEM_DB_MIGRATIONS: SqliteMigration[] = [
    {
        version: 1,
        id: 'baseline',
        up: async client => {
            await client.executeMultiple(SYSTEM_DDL)
            await ensureSessionSourceColumn(client)
            await ensureColumns(client, 'runs', RUN_TELEMETRY_COLUMNS)
            await ensureColumns(client, 'memories', MEMORY_DECAY_COLUMNS)
            await ensureColumns(client, 'skill_proposals', SKILL_PROPOSAL_MODEL_COLUMNS)
        },
    },
    {
        version: 2,
        id: 'message-author',
        up: async client => {
            await ensureColumns(client, 'messages', MESSAGE_AUTHOR_COLUMNS)
        },
    },
    {
        version: 3,
        id: 'step-cache-cost',
        up: async client => {
            await ensureColumns(client, 'run_steps', RUN_STEP_CACHE_COST_COLUMNS)
        },
    },
    {
        version: 4,
        id: 'desktop-regenerated-conversations',
        up: async client => {
            await client.execute(`CREATE TABLE IF NOT EXISTS desktop_regenerations (
                request_id TEXT PRIMARY KEY, source_session_id TEXT NOT NULL, source_message_id TEXT NOT NULL,
                session_id TEXT NOT NULL UNIQUE, run_id TEXT NOT NULL UNIQUE
            )`)
        },
    },
    {
        version: 5,
        id: 'desktop-message-sources',
        up: client => ensureColumns(client, 'messages', ['sources_json TEXT']),
    },
    {
        version: 6,
        id: 'desktop-queued-turns',
        up: client => client.execute('CREATE TABLE IF NOT EXISTS desktop_queued_turns (run_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, message_id TEXT NOT NULL UNIQUE)').then(() => undefined),
    },
    {
        version: 7,
        id: 'desktop-first-turn-input',
        up: client => client.execute('CREATE TABLE IF NOT EXISTS desktop_first_turns (run_id TEXT PRIMARY KEY, session_id TEXT NOT NULL UNIQUE, fingerprint TEXT NOT NULL, message_id TEXT NOT NULL UNIQUE)').then(() => undefined),
    },
    {
        version: 8,
        id: 'desktop-trigger-intents-and-deliveries',
        up: async client => {
            await client.executeMultiple(desktopTriggerStateSchema)
            await ensureColumns(client, 'desktop_trigger_events', ['request_fingerprint TEXT', 'pending_tool_call_id TEXT', 'stop_request_id TEXT'])
        },
    },
    { version: 9, id: 'desktop-schedule-tool-intents', up: client => client.executeMultiple(DESKTOP_SCHEDULE_TOOL_SCHEMA_SQL) },
    { version: 10, id: 'desktop-guest-shell-receipts', up: client => client.executeMultiple(DESKTOP_GUEST_SHELL_SCHEMA_SQL) },
    { version: 11, id: 'desktop-trigger-human-admission', up: client => client.executeMultiple(DESKTOP_TRIGGER_HUMAN_SQL) },
]

export const SYSTEM_DB_VERSION = latestVersion(SYSTEM_DB_MIGRATIONS)

export async function migrateSystemDb(client: Client, file: string): Promise<void> {
    await migrateSqlite(client, SYSTEM_DB_MIGRATIONS, file)
}

async function open(id: string): Promise<SystemDb> {
    mkdirSync(agentDataDir(id), { recursive: true })
    const client = createClient({ url: `file:${systemDbPath(id)}` })
    await migrateSystemDb(client, systemDbPath(id))
    // Reconcile the managed Mac Foreman's tables independently of the shared migration ladder.
    if (desktopApp() && id === FOREMAN_AGENT_ID) await client.executeMultiple(`
        CREATE TABLE IF NOT EXISTS desktop_foreman_reply_sources (
            run_id TEXT PRIMARY KEY NOT NULL,
            workspace_id TEXT NOT NULL,
            chat_id TEXT NOT NULL,
            user_message_id TEXT NOT NULL,
            assistant_message_id TEXT UNIQUE,
            reply_digest TEXT
        );
        CREATE TABLE IF NOT EXISTS desktop_foreman_alternate_sessions (
            request_id TEXT PRIMARY KEY NOT NULL,
            workspace_id TEXT NOT NULL,
            chat_id TEXT NOT NULL,
            source_session_id TEXT NOT NULL,
            source_message_id TEXT NOT NULL,
            source_run_id TEXT NOT NULL,
            source_user_message_id TEXT NOT NULL,
            reply_digest TEXT NOT NULL,
            transcript_revision TEXT NOT NULL,
            session_id TEXT UNIQUE NOT NULL,
            run_id TEXT UNIQUE NOT NULL,
            user_message_id TEXT UNIQUE NOT NULL
        );
    `)
    const entry: SystemDb = { client, db: drizzle(client, { schema }) }
    pool.set(id, entry)
    return entry
}

export async function getSystemDb(id: string): Promise<SystemDb> {
    const release = beginDesktopAgentWork(id)
    try {
        const cached = pool.get(id)
        if (cached) return cached
        const inflight = opening.get(id)
        if (inflight) return await inflight
        const promise = open(id).finally(() => opening.delete(id))
        opening.set(id, promise)
        return await promise
    } finally { release() }
}

export function systemDbExists(id: string): boolean {
    return existsSync(systemDbPath(id))
}

export function closeSystemDb(id: string): void {
    const entry = pool.get(id)
    if (!entry) return
    pool.delete(id)
    try {
        entry.client.close()
    } catch {}
}

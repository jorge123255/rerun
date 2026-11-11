import 'server-only'
import { seedDesktopWorkspaceMetadataOutbox } from './workspaces/metadata'
import { readDesktopWorkspaceIconSelection, writeDesktopWorkspaceIcon } from './workspace-icon'
import { desktopWorkspaceIconById } from '../icon-catalog'
import { mkdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createClient, type Client } from '@libsql/client'
import { ensureDesktopComposerUploadsSchema } from './composer-uploads'
import { initializeDesktopNotifications } from './notifications'
import { initializeDesktopCompletions } from './completed-actions-db'
import { initializeDesktopPendingInbox } from './pending-inbox-db'
import { initializeDesktopSpaces } from './spaces'
import { initializeDesktopDataPreferences } from './data-preferences-db'
import { initializeDesktopMcp } from './mcp/schema'
import { ensureDesktopPrivateFileToolsSchema } from './private-file-tools/schema'
import { initializeDesktopRound35 } from './round35-schema'
import { initializeDesktopRound36 } from './round36-schema'
import { initializeDesktopRound38 } from './round38-schema'
import { initializeDesktopRound37 } from './round37-schema'
import { initializeDesktopRound34 } from './round34-schema'
import { initializeDesktopRound33 } from './round33-schema'
import { initializeDesktopRound32 } from './round32-schema'
import { initializeDesktopRound31 } from './round31-schema'
import { initializeDesktopRound28 } from './round28-schema'
import { ensureDesktopSetupSchema } from './setup/schema'
import { ensureDesktopServiceSuggestionSchema } from './service-requests/schema'
import { initializeDesktopTemplates } from './templates/schema'
import { initializeDesktopCreation } from './new-agent-schema'

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
        CREATE TABLE IF NOT EXISTS desktop_language (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            locale TEXT
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
            enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS desktop_duplicates (
            request_id TEXT PRIMARY KEY,
            source_id TEXT NOT NULL,
            agent_id TEXT NOT NULL UNIQUE,
            name TEXT NOT NULL,
            handle TEXT NOT NULL,
            board_col INTEGER NOT NULL,
            board_row INTEGER NOT NULL,
            completed INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS desktop_rename_checks (
            agent_id TEXT PRIMARY KEY REFERENCES desktop_agents(id) ON DELETE CASCADE,
            name TEXT NOT NULL,
            handle TEXT NOT NULL,
            operation_id TEXT NOT NULL,
            launch_nonce TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS desktop_deletions (
            agent_id TEXT PRIMARY KEY,
            engine_agent_id TEXT NOT NULL UNIQUE,
            name TEXT NOT NULL,
            completed INTEGER NOT NULL DEFAULT 0 CHECK (completed IN (0, 1))
        );
        CREATE TABLE IF NOT EXISTS desktop_recent_state (
            workspace_id INTEGER PRIMARY KEY REFERENCES desktop_workspace(id),
            revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
            request_id TEXT,
            agent_id TEXT
        );
        CREATE TABLE IF NOT EXISTS desktop_recent_coworkers (
            agent_id TEXT PRIMARY KEY REFERENCES desktop_agents(id) ON DELETE CASCADE,
            visit_order INTEGER NOT NULL CHECK (visit_order > 0)
        );
        CREATE TABLE IF NOT EXISTS desktop_sessions (
            id TEXT PRIMARY KEY,
            agent_id TEXT NOT NULL REFERENCES desktop_agents(id) ON DELETE CASCADE,
            engine_session_id TEXT NOT NULL UNIQUE,
            title TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            model_connection_id TEXT,
            model TEXT,
            kind TEXT NOT NULL DEFAULT 'thread' CHECK (kind IN ('general', 'thread')),
            first_message TEXT
        );
        CREATE TABLE IF NOT EXISTS desktop_agent_tabs (
            agent_id TEXT PRIMARY KEY REFERENCES desktop_agents(id) ON DELETE CASCADE,
            revision INTEGER NOT NULL,
            layout TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS desktop_composer_drafts (
            agent_id TEXT NOT NULL REFERENCES desktop_agents(id) ON DELETE CASCADE,
            tab_uid TEXT NOT NULL,
            revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
            text TEXT NOT NULL DEFAULT '',
            attachment_path TEXT,
            updated_at TEXT NOT NULL,
            PRIMARY KEY (agent_id, tab_uid)
        );
        CREATE TABLE IF NOT EXISTS desktop_composer_draft_writes (
            request_id TEXT PRIMARY KEY,
            agent_id TEXT NOT NULL,
            tab_uid TEXT NOT NULL,
            fingerprint TEXT NOT NULL,
            result_revision INTEGER NOT NULL,
            cleared INTEGER NOT NULL DEFAULT 0 CHECK (cleared IN (0, 1)),
            FOREIGN KEY (agent_id, tab_uid) REFERENCES desktop_composer_drafts(agent_id, tab_uid) ON DELETE CASCADE
        );
        CREATE TABLE IF NOT EXISTS desktop_queued_messages (
            agent_id TEXT NOT NULL REFERENCES desktop_agents(id) ON DELETE CASCADE,
            target TEXT NOT NULL,
            session_id TEXT REFERENCES desktop_sessions(id) ON DELETE CASCADE,
            message_id TEXT NOT NULL UNIQUE,
            payload TEXT NOT NULL,
            PRIMARY KEY(agent_id, target)
        );
        CREATE TABLE IF NOT EXISTS desktop_tab_starts (
            agent_id TEXT NOT NULL REFERENCES desktop_agents(id) ON DELETE CASCADE,
            uid TEXT NOT NULL,
            input_hash TEXT NOT NULL,
            engine_session_id TEXT NOT NULL UNIQUE,
            run_id TEXT NOT NULL UNIQUE,
            title TEXT NOT NULL,
            model_choice TEXT NOT NULL,
            launch_nonce TEXT NOT NULL,
            PRIMARY KEY(agent_id, uid)
        );
        CREATE TABLE IF NOT EXISTS desktop_regeneration_requests (
            request_id TEXT PRIMARY KEY,
            source_session_id TEXT NOT NULL REFERENCES desktop_sessions(id) ON DELETE CASCADE,
            message_id TEXT NOT NULL,
            canonical_id TEXT NOT NULL,
            pending INTEGER NOT NULL CHECK (pending IN (0, 1)),
            alternate_session_id TEXT REFERENCES desktop_sessions(id) ON DELETE SET NULL
        );
        CREATE UNIQUE INDEX IF NOT EXISTS desktop_regeneration_pending
            ON desktop_regeneration_requests(source_session_id, message_id) WHERE pending = 1;
        CREATE UNIQUE INDEX IF NOT EXISTS desktop_regeneration_alternate
            ON desktop_regeneration_requests(alternate_session_id) WHERE alternate_session_id IS NOT NULL;
        CREATE TABLE IF NOT EXISTS desktop_message_feedback (
            id TEXT PRIMARY KEY,
            agent_id TEXT NOT NULL REFERENCES desktop_agents(id) ON DELETE CASCADE,
            session_id TEXT NOT NULL REFERENCES desktop_sessions(id) ON DELETE CASCADE,
            message_id TEXT NOT NULL,
            rating TEXT NOT NULL CHECK (rating IN ('up', 'down')),
            category TEXT,
            details TEXT,
            updated_at TEXT NOT NULL,
            UNIQUE (session_id, message_id)
        );
        CREATE TABLE IF NOT EXISTS desktop_question_answers (
            request_id TEXT PRIMARY KEY,
            agent_id TEXT NOT NULL REFERENCES desktop_agents(id) ON DELETE CASCADE,
            session_id TEXT NOT NULL REFERENCES desktop_sessions(id) ON DELETE CASCADE,
            question_id TEXT NOT NULL,
            question_guard TEXT NOT NULL,
            payload TEXT NOT NULL,
            answer_text TEXT NOT NULL,
            accepted INTEGER NOT NULL DEFAULT 0 CHECK (accepted IN (0, 1)),
            created_at TEXT NOT NULL,
            UNIQUE (session_id, question_id)
        );
        CREATE TABLE IF NOT EXISTS desktop_question_requests (
            request_id TEXT PRIMARY KEY,
            answer_id TEXT NOT NULL REFERENCES desktop_question_answers(request_id) ON DELETE CASCADE
        );
        CREATE TABLE IF NOT EXISTS desktop_takeover_answers (
            request_id TEXT PRIMARY KEY,
            agent_id TEXT NOT NULL REFERENCES desktop_agents(id) ON DELETE CASCADE,
            session_id TEXT NOT NULL REFERENCES desktop_sessions(id) ON DELETE CASCADE,
            takeover_id TEXT NOT NULL, takeover_guard TEXT NOT NULL, payload TEXT NOT NULL,
            answer_text TEXT NOT NULL, accepted INTEGER NOT NULL DEFAULT 0 CHECK(accepted IN (0,1)), created_at TEXT NOT NULL,
            UNIQUE(session_id, takeover_id)
        );
        CREATE TABLE IF NOT EXISTS desktop_takeover_requests (
            request_id TEXT PRIMARY KEY, answer_id TEXT NOT NULL REFERENCES desktop_takeover_answers(request_id) ON DELETE CASCADE
        );
        CREATE TABLE IF NOT EXISTS desktop_takeover_screens (
            takeover_id TEXT PRIMARY KEY,
            agent_id TEXT NOT NULL REFERENCES desktop_agents(id) ON DELETE CASCADE,
            session_id TEXT NOT NULL REFERENCES desktop_sessions(id) ON DELETE CASCADE,
            launch_nonce TEXT NOT NULL, lease TEXT NOT NULL, result_url TEXT,
            released INTEGER NOT NULL DEFAULT 0 CHECK(released IN (0,1)), created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS desktop_approval_answers (
            request_id TEXT PRIMARY KEY,
            agent_id TEXT NOT NULL REFERENCES desktop_agents(id) ON DELETE CASCADE,
            session_id TEXT NOT NULL REFERENCES desktop_sessions(id) ON DELETE CASCADE,
            approval_id TEXT NOT NULL,
            approval_guard TEXT NOT NULL,
            payload TEXT NOT NULL,
            answer_text TEXT NOT NULL,
            accepted INTEGER NOT NULL DEFAULT 0 CHECK (accepted IN (0, 1)),
            created_at TEXT NOT NULL,
            UNIQUE (session_id, approval_id)
        );
        CREATE TABLE IF NOT EXISTS desktop_approval_requests (
            request_id TEXT PRIMARY KEY,
            answer_id TEXT NOT NULL REFERENCES desktop_approval_answers(request_id) ON DELETE CASCADE
        );
        PRAGMA user_version = 1;
    `)
    const columns = await client.execute('PRAGMA table_info(desktop_sessions)')
    const names = new Set(columns.rows.map(row => String(row.name)))
    if (!names.has('model_connection_id')) await client.execute('ALTER TABLE desktop_sessions ADD COLUMN model_connection_id TEXT')
    if (!names.has('model')) await client.execute('ALTER TABLE desktop_sessions ADD COLUMN model TEXT')
    const agentColumns = await client.execute('PRAGMA table_info(desktop_agents)')
    if (!agentColumns.rows.some(row => row.name === 'enabled'))
        await client.execute('ALTER TABLE desktop_agents ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1))')
    const draftColumns = await client.execute('PRAGMA table_info(desktop_composer_drafts)')
    if (!draftColumns.rows.some(row => row.name === 'attachment_paths'))
        await client.execute('ALTER TABLE desktop_composer_drafts ADD COLUMN attachment_paths TEXT')
    if (!draftColumns.rows.some(row => row.name === 'attachment_items'))
        await client.execute('ALTER TABLE desktop_composer_drafts ADD COLUMN attachment_items TEXT')
    const now = new Date().toISOString()
    const nativeContext = process.env.RERUN_DESKTOP_APP === '1' && process.env.RERUN_DESKTOP_DATA_DIR && resolve(process.env.RERUN_DESKTOP_DATA_DIR) === resolve(dataRoot)
    const assignedName = nativeContext ? process.env.RERUN_DESKTOP_WORKSPACE_NAME?.trim() : undefined
    const initialName = assignedName && assignedName.length <= 60 ? assignedName : 'My workspace'
    const seeded = await client.batch([
        { sql: 'INSERT OR IGNORE INTO desktop_profile (id, display_name, created_at, updated_at) VALUES (1, ?, ?, ?)', args: ['Local User', now, now] },
        { sql: 'INSERT OR IGNORE INTO desktop_workspace (id, profile_id, name, created_at, updated_at) VALUES (1, 1, ?, ?, ?)', args: [initialName, now, now] },
    ], 'write')
    await ensureDesktopComposerUploadsSchema(client)
    await initializeDesktopNotifications(client)
    await initializeDesktopCompletions(client)
    await initializeDesktopPendingInbox(client)
    await initializeDesktopCreation(client)
    await initializeDesktopTemplates(client)
    await ensureDesktopSetupSchema(client)
    await ensureDesktopServiceSuggestionSchema(client)
    await initializeDesktopSpaces(client)
    await initializeDesktopDataPreferences(client)
    await initializeDesktopMcp(client)
    await ensureDesktopPrivateFileToolsSchema(client)
    await initializeDesktopRound28(client)
    await initializeDesktopRound31(client)
    await initializeDesktopRound32(client)
    await initializeDesktopRound33(client)
    await initializeDesktopRound34(client)
    await initializeDesktopRound35(client)
    await initializeDesktopRound36(client)
    await initializeDesktopRound37(client)
    await initializeDesktopRound38(client)
    if (nativeContext) {
        const assignedIcon = process.env.RERUN_DESKTOP_WORKSPACE_ICON
        if (seeded[1].rowsAffected && assignedIcon && desktopWorkspaceIconById(assignedIcon)) await writeDesktopWorkspaceIcon(client, { name: initialName, catalogId: assignedIcon })
        const name = String((await client.execute('SELECT name FROM desktop_workspace WHERE id=1')).rows[0].name)
        const saved = await readDesktopWorkspaceIconSelection(client)
        await seedDesktopWorkspaceMetadataOutbox(client, name, saved.iconCatalogId)
    }
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

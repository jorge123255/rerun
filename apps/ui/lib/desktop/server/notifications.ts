import 'server-only'
import type { Client } from '@libsql/client'
import { coworkerRuleOf, mergeNotificationPrefs, normalizeNotificationPrefs, notificationPrefsPatchSchema, taskNotifies, taskRuleOf,
    type NotificationPrefs, type NotificationPrefsPatch } from '@rerun/contracts'
import type { NotificationPayload } from '@/lib/engine/types'
import { readDesktopCompletions } from './completed-actions'
import { readDesktopAttention } from './attention'
import { DesktopHttpError } from './auth'
import { openDesktopDatabase } from './database'
import type { DesktopRuntime } from './runtime'

// The desktop notification slice keeps its own tables beside the central schema, so the central
// database/store files stay untouched: this module owns the initializer and runs it lazily on the
// same pooled client before the first read or write.
//
// `desktop_notifications_state` seeds one install-time cutoff the way the completions store does:
// everything raised before the slice's first boot is old history that must never replay as a new
// notification, whatever a later restart does to the seen ledger.
//
// `desktop_notification_terminals` records the engine's cancelled/error run terminals, which the
// completion store deliberately never keeps: they are the only local trace a stopped or failed
// run leaves for a « Done »-style notification.
const CREATE_DESKTOP_NOTIFICATIONS = `
    CREATE TABLE IF NOT EXISTS desktop_notification_prefs (
        workspace_id INTEGER PRIMARY KEY REFERENCES desktop_workspace(id),
        prefs TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS desktop_notifications_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        enabled_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS desktop_notifications_seen (
        event_key TEXT PRIMARY KEY,
        notified_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS desktop_notification_terminals (
        id TEXT PRIMARY KEY,
        agent_engine_id TEXT NOT NULL,
        session_engine_id TEXT,
        run_id TEXT,
        source TEXT NOT NULL CHECK (source IN ('chat', 'schedule', 'trigger')),
        slug TEXT,
        status TEXT NOT NULL,
        message TEXT,
        completed_at TEXT NOT NULL,
        created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS desktop_notification_terminals_time_idx ON desktop_notification_terminals(completed_at DESC);
`

const ensured = new WeakMap<Client, Promise<void>>()

export async function initializeDesktopNotifications(db: Client): Promise<void> {
    let ready = ensured.get(db)
    if (!ready) {
        ready = (async () => {
            await db.executeMultiple(CREATE_DESKTOP_NOTIFICATIONS)
            await db.execute({ sql: 'INSERT INTO desktop_notifications_state (id,enabled_at) VALUES (1,?) ON CONFLICT(id) DO NOTHING', args: [new Date().toISOString()] })
        })()
        ensured.set(db, ready)
        // A failed initializer must not poison later calls: the next one retries.
        void ready.catch(() => ensured.delete(db))
    }
    return ready
}

export async function readDesktopNotificationPrefs(db: Client): Promise<NotificationPrefs> {
    await initializeDesktopNotifications(db)
    const row = (await db.execute('SELECT prefs FROM desktop_notification_prefs WHERE workspace_id = 1')).rows[0]
    let stored: unknown
    try { stored = row ? JSON.parse(String(row.prefs)) : undefined } catch { stored = undefined }
    return normalizeNotificationPrefs(stored)
}

// Every write reads the stored value, merges the patch on top and writes the whole object back,
// so a surface that only touches one field never clobbers the rest. The merged result comes back
// as the authoritative value for the submitting surface.
export async function writeDesktopNotificationPrefs(db: Client, patch: NotificationPrefsPatch): Promise<NotificationPrefs> {
    const parsed = notificationPrefsPatchSchema.safeParse(patch)
    if (!parsed.success) throw new DesktopHttpError(400, 'Choose a valid notification scope, channel or coworker rule.')
    await initializeDesktopNotifications(db)
    const merged = mergeNotificationPrefs(await readDesktopNotificationPrefs(db), parsed.data)
    const now = new Date().toISOString()
    await db.execute({
        sql: 'INSERT INTO desktop_notification_prefs (workspace_id,prefs,created_at,updated_at) VALUES (1,?,?,?) ON CONFLICT(workspace_id) DO UPDATE SET prefs=excluded.prefs,updated_at=excluded.updated_at',
        args: [JSON.stringify(merged), now, now],
    })
    return merged
}

export type DesktopNotificationEvent = {
    key: string
    kind: 'done' | 'error' | 'question' | 'approval'
    agentId: string
    agentName: string
    sessionId: string
    title: string
    subtitle: string
    body: string | null
    silent: boolean
    // The revalidation identity a notification click resolves against: the finished-run group
    // for a completion, the recorded terminal for a stopped or failed run, the exact pending
    // request hash for a question or approval.
    groupId?: string
    terminalId?: string
    requestId?: string
}

type WantedEvent = { kind: 'done' | 'error' | 'question' | 'approval'; agentId: string; source: 'chat' | 'schedule' | 'trigger'; slug: string | null }

// The one question of the settings, mirrored from the original audience rules for the single
// local member: scope first, then the coworker's own override, then whether the run reaches the
// user at all, and only then the scope's loudness gate — « needed » keeps finished runs quiet,
// a followed task included, but a run that broke is urgent and still reaches, exactly like the
// original 'error' kind.
function wantedByPrefs(prefs: NotificationPrefs, event: WantedEvent): boolean {
    if (prefs.scope === 'nothing') return false
    const rule = coworkerRuleOf(prefs, event.agentId)
    if (rule.mode === 'muted') return false
    if (rule.mode === 'everything') return true
    if (event.kind === 'question' || event.kind === 'approval') return true
    const reaches = event.source === 'chat'
        ? prefs.scope === 'everything' || prefs.scope === 'mine' || prefs.scope === 'needed'
        : event.slug
            ? taskNotifies(prefs, event.agentId, event.source, event.slug)
            : rule.follow === true || prefs.scope === 'everything'
    if (!reaches) return false
    return prefs.scope !== 'needed' || event.kind === 'error'
}

const TERMINAL_PRUNE_MS = 30 * 24 * 60 * 60 * 1000
const TERMINAL_MESSAGE_MAX = 2000

function terminalSourceOf(event: string): WantedEvent['source'] | null {
    if (event === 'agent.message.completed') return 'chat'
    if (event === 'agent.schedule.completed') return 'schedule'
    if (event === 'agent.trigger.completed') return 'trigger'
    return null
}

function metadataString(metadata: Record<string, unknown> | null | undefined, key: string): string | null {
    const value = metadata?.[key]
    return typeof value === 'string' && value ? value : null
}

// The hosted owner-follow, single-member edition: the first scheduled task on a coworker nobody
// has ruled on (no follow choice, no mute, no « notify me » switch) starts reaching the local
// user, merged through the same patch path the settings surface writes. It runs for every
// schedule/trigger terminal, kept or not, like the original audience resolution.
async function followScheduledTask(db: Client, agentId: string, source: 'schedule' | 'trigger', slug: string | null): Promise<void> {
    const prefs = await readDesktopNotificationPrefs(db)
    const rule = coworkerRuleOf(prefs, agentId)
    if (rule.follow !== undefined || rule.mode === 'muted' || taskRuleOf(prefs, agentId, source, slug) !== undefined) return
    await writeDesktopNotificationPrefs(db, { coworkers: { [agentId]: { ...rule, follow: true } } })
}

// The engine's terminal webhook is the only place a cancelled or failed run is ever announced on
// the desktop: the completion store deliberately keeps genuine `done` terminals only, so this
// intake records just those. The row keeps engine identities; reads re-map them onto the current
// local coworker/session like the completions projection does. Returns whether a row was kept.
export async function recordDesktopRunTerminal(runtime: DesktopRuntime, payload: NotificationPayload): Promise<boolean> {
    const source = terminalSourceOf(payload.event)
    if (!source || !payload.agentId) return false
    const db = await openDesktopDatabase(runtime.dataRoot)
    await initializeDesktopNotifications(db)
    const agent = (await db.execute({
        sql: `SELECT a.id FROM desktop_agents a LEFT JOIN desktop_deletions d ON d.agent_id = a.id
              WHERE a.engine_agent_id = ? AND a.workspace_id = 1 AND d.agent_id IS NULL`,
        args: [payload.agentId],
    })).rows[0]
    if (!agent) return false
    const agentId = String(agent.id)
    const metadata = payload.metadata ?? undefined
    const slug = source === 'schedule' ? metadataString(metadata, 'scheduleSlug') : source === 'trigger' ? metadataString(metadata, 'triggerSlug') : null
    if (source !== 'chat') await followScheduledTask(db, agentId, source, slug)
    const status = metadataString(metadata, 'status') ?? (payload.kind === 'error' ? 'error' : 'done')
    if (status !== 'cancelled' && payload.kind !== 'error') return false
    const id = payload.runId ?? `${payload.agentId}:${payload.sessionId ?? ''}:${payload.timestamp}`
    const message = payload.message.replace(/\s+/g, ' ').trim().slice(0, TERMINAL_MESSAGE_MAX) || null
    await db.execute({
        sql: `INSERT INTO desktop_notification_terminals (id, agent_engine_id, session_engine_id, run_id, source, slug, status, message, completed_at, created_at)
              VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING`,
        args: [id, payload.agentId, payload.sessionId ?? null, payload.runId ?? null, source, slug, status, message, payload.timestamp, new Date().toISOString()],
    })
    // Kept rows live as long as the seen ledger: long enough to deduplicate across restarts,
    // pruned on write so the table never grows forever.
    await db.execute({ sql: 'DELETE FROM desktop_notification_terminals WHERE completed_at < ?', args: [new Date(Date.now() - TERMINAL_PRUNE_MS).toISOString()] })
    return true
}

// The click revalidation for a stopped or failed run: the recorded terminal re-mapped onto the
// current local coworker and conversation. A deleted coworker, a rebound session or a pruned row
// resolves to nothing and the click lands nowhere.
export async function readDesktopTerminalBinding(db: Client, id: string): Promise<{ agentId: string; sessionId: string } | null> {
    await initializeDesktopNotifications(db)
    if (!/^[A-Za-z0-9:._-]{8,600}$/.test(id)) return null
    const row = (await db.execute({
        sql: `SELECT a.id AS agent_id, s.id AS session_id
              FROM desktop_notification_terminals t
              JOIN desktop_agents a ON a.engine_agent_id = t.agent_engine_id AND a.workspace_id = 1
              JOIN desktop_sessions s ON s.agent_id = a.id AND s.engine_session_id = t.session_engine_id
              LEFT JOIN desktop_deletions d ON d.agent_id = a.id
              WHERE t.id = ? AND d.agent_id IS NULL`,
        args: [id],
    })).rows[0]
    return row ? { agentId: String(row.agent_id), sessionId: String(row.session_id) } : null
}

// The events a mounted delivery should announce, newest first: everything the scope and the
// coworker rules want, minus anything this install already announced and everything raised
// before the slice's first boot. Polling, reconnecting and restarting cannot replay old history
// as new.
export async function readDesktopNotificationEvents(runtime: DesktopRuntime): Promise<{ events: DesktopNotificationEvent[]; channels: { toast: boolean; sound: boolean }; unavailableAgentIds: string[]; checkedAt: string }> {
    const db = await openDesktopDatabase(runtime.dataRoot)
    await initializeDesktopNotifications(db)
    const prefs = await readDesktopNotificationPrefs(db)
    const state = (await db.execute('SELECT enabled_at FROM desktop_notifications_state WHERE id=1')).rows[0]
    const enabledAt = state ? String(state.enabled_at) : new Date().toISOString()
    const enabledAtMs = Date.parse(enabledAt)
    const seen = new Set((await db.execute('SELECT event_key FROM desktop_notifications_seen')).rows.map(row => String(row.event_key)))
    const scored: { at: number; event: DesktopNotificationEvent }[] = []
    let unavailableAgentIds: string[] = []
    if (prefs.scope !== 'nothing') {
        const [completions, attention] = await Promise.all([readDesktopCompletions(runtime), readDesktopAttention(runtime)])
        unavailableAgentIds = [...new Set([...completions.unavailableAgentIds, ...attention.unavailableAgentIds])]
        for (const item of completions.items) {
            const key = `${item.id}:${item.completedAt}`
            const at = Date.parse(item.completedAt)
            if (seen.has(key) || !Number.isFinite(at) || at < enabledAtMs) continue
            if (!wantedByPrefs(prefs, { kind: 'done', agentId: item.agentId, source: item.source, slug: item.slug })) continue
            const sourceName = item.source !== 'chat' && item.slug ? item.slug : null
            scored.push({ at, event: {
                key, kind: 'done', agentId: item.agentId, agentName: item.agentName, sessionId: item.sessionId,
                title: item.agentName, subtitle: sourceName ? `${sourceName} · Done` : 'Done',
                // A finished schedule only says "completed", which the subtitle already does.
                body: item.source === 'chat' ? item.message : null, silent: true, groupId: item.id,
            } })
        }
        for (const item of attention.items) {
            const key = `pending:${item.id}`
            const at = Date.parse(item.requestedAt ?? item.updatedAt)
            if (seen.has(key) || !Number.isFinite(at) || at < enabledAtMs) continue
            if (!wantedByPrefs(prefs, { kind: item.kind, agentId: item.agentId, source: 'chat', slug: null })) continue
            scored.push({ at, event: {
                key, kind: item.kind, agentId: item.agentId, agentName: item.agentName, sessionId: item.sessionId,
                title: item.agentName, subtitle: item.kind === 'question' ? 'Question' : 'Needs approval',
                body: item.summary || null, silent: false, requestId: item.id,
            } })
        }
        const terminalRows = (await db.execute({
            sql: `SELECT t.id, t.source, t.slug, t.status, t.message, t.completed_at, a.id AS agent_id, a.name AS agent_name, s.id AS session_id
                  FROM desktop_notification_terminals t
                  JOIN desktop_agents a ON a.engine_agent_id = t.agent_engine_id AND a.workspace_id = 1
                  JOIN desktop_sessions s ON s.agent_id = a.id AND s.engine_session_id = t.session_engine_id
                  LEFT JOIN desktop_deletions d ON d.agent_id = a.id
                  WHERE d.agent_id IS NULL
                  ORDER BY t.completed_at DESC LIMIT 200`,
        })).rows
        for (const row of terminalRows) {
            const key = `terminal:${String(row.id)}`
            const at = Date.parse(String(row.completed_at))
            if (seen.has(key) || !Number.isFinite(at) || at < enabledAtMs) continue
            const agentId = String(row.agent_id)
            const slug = row.slug == null ? null : String(row.slug)
            const terminalKind: 'done' | 'error' = row.status === 'error' ? 'error' : 'done'
            if (!wantedByPrefs(prefs, { kind: terminalKind, agentId, source: String(row.source) as WantedEvent['source'], slug })) continue
            scored.push({ at, event: {
                key, kind: terminalKind, agentId, agentName: String(row.agent_name), sessionId: String(row.session_id),
                title: String(row.agent_name), subtitle: slug ? `${slug} · Done` : 'Done',
                body: row.message ? String(row.message) : null, silent: terminalKind === 'done', terminalId: String(row.id),
            } })
        }
    }
    scored.sort((a, b) => b.at - a.at)
    return { events: scored.map(entry => entry.event), channels: { toast: prefs.toast, sound: prefs.sound }, unavailableAgentIds, checkedAt: new Date().toISOString() }
}

// Recorded only after the mounted delivery announced the event; a failed delivery keeps its key
// out of the ledger, so the next poll can try again. Acknowledged rows live for a month, long
// enough to deduplicate across restarts without growing forever.
export async function acknowledgeDesktopNotificationEvents(db: Client, keys: readonly string[]): Promise<void> {
    await initializeDesktopNotifications(db)
    const now = new Date().toISOString()
    const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()
    for (const key of keys.slice(0, 200)) {
        if (!/^[A-Za-z0-9:._-]{8,600}$/.test(key)) continue
        await db.execute({ sql: 'INSERT INTO desktop_notifications_seen (event_key,notified_at) VALUES (?,?) ON CONFLICT(event_key) DO UPDATE SET notified_at=excluded.notified_at', args: [key, now] })
    }
    await db.execute({ sql: 'DELETE FROM desktop_notifications_seen WHERE notified_at < ?', args: [cutoff] })
}

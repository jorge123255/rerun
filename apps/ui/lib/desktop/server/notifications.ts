import 'server-only'
import type { Client } from '@libsql/client'
import { coworkerRuleOf, mergeNotificationPrefs, normalizeNotificationPrefs, notificationPrefsPatchSchema, taskNotifies,
    type NotificationPrefs, type NotificationPrefsPatch } from '@rerun/contracts'
import { readDesktopCompletions } from './completed-actions'
import { readDesktopAttention } from './attention'
import { DesktopHttpError } from './auth'
import { openDesktopDatabase } from './database'

// The desktop notification slice keeps its own tables beside the central schema, so the central
// database/store files stay untouched: this module owns the initializer and runs it lazily on the
// same pooled client before the first read or write.
//
// `desktop_notifications_state` seeds one install-time cutoff the way the completions store does:
// everything raised before the slice's first boot is old history that must never replay as a new
// notification, whatever a later restart does to the seen ledger.
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
    kind: 'done' | 'question' | 'approval'
    agentId: string
    agentName: string
    sessionId: string
    title: string
    subtitle: string
    body: string | null
    silent: boolean
    // The revalidation identity a notification click resolves against: the finished-run group
    // for `done`, the exact pending request hash for a question or approval.
    groupId?: string
    requestId?: string
}

type WantedEvent = { kind: 'done' | 'question' | 'approval'; agentId: string; source: 'chat' | 'schedule' | 'trigger'; slug: string | null }

// The one question of the settings, mirrored from the original audience rules: scope first, then
// the coworker's own override, then the scheduled task's own switch.
function wantedByPrefs(prefs: NotificationPrefs, event: WantedEvent): boolean {
    if (prefs.scope === 'nothing') return false
    const rule = coworkerRuleOf(prefs, event.agentId)
    if (rule.mode === 'muted') return false
    if (rule.mode === 'everything') return true
    if (event.kind !== 'done') return true
    if (event.source !== 'chat' && event.slug) return taskNotifies(prefs, event.agentId, event.source, event.slug)
    // A run the user started reaches them under « everything » and « mine »; « needed » keeps
    // finished runs quiet.
    return prefs.scope === 'everything' || prefs.scope === 'mine'
}

// The events a mounted delivery should announce: everything the scope and the coworker rules
// want, minus anything this install already announced and everything raised before the slice's
// first boot. Polling, reconnecting and restarting cannot replay old history as new.
export async function readDesktopNotificationEvents(runtime: DesktopRuntime): Promise<{ events: DesktopNotificationEvent[]; channels: { toast: boolean; sound: boolean }; unavailableAgentIds: string[]; checkedAt: string }> {
    const db = await openDesktopDatabase(runtime.dataRoot)
    await initializeDesktopNotifications(db)
    const prefs = await readDesktopNotificationPrefs(db)
    const state = (await db.execute('SELECT enabled_at FROM desktop_notifications_state WHERE id=1')).rows[0]
    const enabledAt = state ? String(state.enabled_at) : new Date().toISOString()
    const seen = new Set((await db.execute('SELECT event_key FROM desktop_notifications_seen')).rows.map(row => String(row.event_key)))
    const events: DesktopNotificationEvent[] = []
    let unavailableAgentIds: string[] = []
    if (prefs.scope !== 'nothing') {
        const [completions, attention] = await Promise.all([readDesktopCompletions(runtime), readDesktopAttention(runtime)])
        unavailableAgentIds = [...completions.unavailableAgentIds]
        for (const item of completions.items) {
            const key = `${item.id}:${item.completedAt}`
            if (seen.has(key) || Date.parse(item.completedAt) < Date.parse(enabledAt)) continue
            if (!wantedByPrefs(prefs, { kind: 'done', agentId: item.agentId, source: item.source, slug: item.slug })) continue
            const sourceName = item.source !== 'chat' && item.slug ? item.slug : null
            events.push({
                key, kind: 'done', agentId: item.agentId, agentName: item.agentName, sessionId: item.sessionId,
                title: item.agentName, subtitle: sourceName ? `${sourceName} · Done` : 'Done',
                // A finished schedule only says "completed", which the subtitle already does.
                body: item.source === 'chat' ? item.message : null, silent: true, groupId: item.id,
            })
        }
        for (const item of attention.items) {
            const key = `pending:${item.id}`
            if (seen.has(key) || Date.parse(item.requestedAt ?? item.updatedAt) < Date.parse(enabledAt)) continue
            if (!wantedByPrefs(prefs, { kind: item.kind, agentId: item.agentId, source: 'chat', slug: null })) continue
            events.push({
                key, kind: item.kind, agentId: item.agentId, agentName: item.agentName, sessionId: item.sessionId,
                title: item.agentName, subtitle: item.kind === 'question' ? 'Question' : 'Needs approval',
                body: item.summary || null, silent: false, requestId: item.id,
            })
        }
    }
    return { events, channels: { toast: prefs.toast, sound: prefs.sound }, unavailableAgentIds, checkedAt: new Date().toISOString() }
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

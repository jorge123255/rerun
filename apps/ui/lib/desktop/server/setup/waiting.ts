import 'server-only'
import type { Client } from '@libsql/client'
import type { Locale } from '@rerun/i18n'
import type { DesktopPendingInboxItem, DesktopPendingReadTarget } from '../../pending-inbox'
import { openDesktopDatabase } from '../database'
import { readDesktopLocale } from '../language'
import type { DesktopRuntime } from '../runtime'
import { findDesktopSession, listDesktopAgents } from '../store'
import { readDesktopSetupWaitingChat } from './service'

// A coworker whose setup was started and now waits for the person shows in the Mac's Actions
// inbox as « Setup waiting for you », opening that setup chat. Read-only: the row answers nothing,
// starts nothing and skips nothing. Until the setup is finished or skipped no other coworker can
// reach this one, and nothing else told the person. « Mark as read » hides this attempt's row only;
// a new setup attempt is a new chat and shows again.

export const DESKTOP_SETUP_WAITING_CONCURRENCY = 4
export const DESKTOP_SETUP_WAITING_DEADLINE_MS = 2_500
const PREFIX = 'setup:'

export const DESKTOP_SETUP_WAITING_SUMMARY: Record<Locale, string> = {
    en: 'Setup waiting for you',
    fr: 'Configuration en attente de votre réponse',
    es: 'Configuración esperando tu respuesta',
    pt: 'Configuração aguardando você',
    de: 'Einrichtung wartet auf dich',
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS desktop_pending_inbox_setup_seen (
    item_id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL REFERENCES desktop_agents(id) ON DELETE CASCADE,
    session_id TEXT NOT NULL REFERENCES desktop_sessions(id) ON DELETE CASCADE,
    seen_at TEXT NOT NULL
);`
const ready = new WeakMap<Client, Promise<void>>()
function ensure(db: Client): Promise<void> {
    let pending = ready.get(db)
    if (!pending) { pending = db.executeMultiple(SCHEMA).then(() => {}); ready.set(db, pending); pending.catch(() => ready.delete(db)) }
    return pending
}

/** One row per setup chat: the id names the local chat, never an engine id. */
export const desktopSetupWaitingItemId = (sessionId: string) => `${PREFIX}${sessionId}`

/** Every switched-on coworker whose started setup waits for the person, minus rows marked read. */
export async function readDesktopSetupWaiting(runtime: DesktopRuntime): Promise<{ items: DesktopPendingInboxItem[]; unavailableAgentIds: string[] }> {
    const signal = AbortSignal.timeout(DESKTOP_SETUP_WAITING_DEADLINE_MS)
    const db = await openDesktopDatabase(runtime.dataRoot)
    await ensure(db)
    const agents = (await listDesktopAgents(db)).filter(agent => agent.workspaceId === 1 && agent.enabled)
    const locale: Locale = await readDesktopLocale(runtime, null).catch(() => 'en' as const)
    const items: DesktopPendingInboxItem[] = []
    const unavailable = new Set<string>()
    let next = 0
    await Promise.all(Array.from({ length: Math.min(DESKTOP_SETUP_WAITING_CONCURRENCY, agents.length) }, async () => {
        for (;;) {
            const agent = agents[next++]
            if (!agent) return
            if (signal.aborted) { unavailable.add(agent.id); continue }
            try {
                const waiting = await readDesktopSetupWaitingChat(runtime, agent.id, signal)
                if (!waiting) continue
                const session = await findDesktopSession(db, waiting.sessionId)
                if (!session || session.agentId !== agent.id) continue
                items.push({
                    id: desktopSetupWaitingItemId(session.id), kind: 'setup', agentId: agent.id, agentName: agent.name, agentEnabled: agent.enabled,
                    sessionId: session.id, title: session.title, summary: DESKTOP_SETUP_WAITING_SUMMARY[locale] ?? DESKTOP_SETUP_WAITING_SUMMARY.en,
                    requestedAt: session.updatedAt, updatedAt: session.updatedAt,
                })
            } catch { unavailable.add(agent.id) }
        }
    }))
    if (!items.length) return { items, unavailableAgentIds: [...unavailable].sort() }
    const seen = new Set((await db.execute({ sql: `SELECT item_id FROM desktop_pending_inbox_setup_seen WHERE item_id IN (${items.map(() => '?').join(',')})`, args: items.map(item => item.id) })).rows.map(row => String(row.item_id)))
    return { items: items.filter(item => !seen.has(item.id)), unavailableAgentIds: [...unavailable].sort() }
}

/** « Mark as read » for one setup row: only while that exact setup chat still waits for the person. */
export async function acknowledgeDesktopSetupWaiting(runtime: DesktopRuntime, item: DesktopPendingReadTarget): Promise<boolean> {
    if (item.kind !== 'setup' || item.id !== desktopSetupWaitingItemId(item.sessionId)) return false
    const db = await openDesktopDatabase(runtime.dataRoot)
    await ensure(db)
    try {
        const waiting = await readDesktopSetupWaitingChat(runtime, item.agentId, AbortSignal.timeout(DESKTOP_SETUP_WAITING_DEADLINE_MS))
        if (waiting?.sessionId !== item.sessionId) return false
        const session = await findDesktopSession(db, item.sessionId)
        if (!session || session.agentId !== item.agentId) return false
        await db.execute({ sql: 'INSERT INTO desktop_pending_inbox_setup_seen (item_id, agent_id, session_id, seen_at) VALUES (?,?,?,?) ON CONFLICT(item_id) DO NOTHING', args: [item.id, item.agentId, item.sessionId, new Date().toISOString()] })
        return true
    } catch { return false }
}

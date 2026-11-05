import 'server-only'
import { resolve } from 'node:path'
import type { DesktopAttention, DesktopAttentionItem } from '../attention'
import { readDesktopApproval } from './approvals'
import { assertCoworkerNotDeleting } from './coworker-delete'
import { openDesktopDatabase } from './database'
import { readDesktopQuestion } from './questions'
import type { DesktopRuntime } from './runtime'
import { findDesktopSession, listDesktopAgents, listDesktopSessions, type DesktopAgent, type DesktopSession } from './store'

export const DESKTOP_ATTENTION_CONCURRENCY = 4
export const DESKTOP_ATTENTION_DEADLINE_MS = 2_500
const shared = globalThis as typeof globalThis & { desktopAttentionReads?: Map<string, Promise<DesktopAttention>> }
const time = (value: string) => { const parsed = Date.parse(value); return Number.isFinite(parsed) ? parsed : 0 }
const summary = (value: string) => value.replace(/\s+/g, ' ').trim().slice(0, 280)

async function collect(runtime: DesktopRuntime): Promise<DesktopAttention> {
    const signal = AbortSignal.timeout(DESKTOP_ATTENTION_DEADLINE_MS)
    const db = await openDesktopDatabase(runtime.dataRoot)
    const agents = (await listDesktopAgents(db)).filter(agent => agent.workspaceId === 1)
    const unavailable = new Set<string>()
    const tasks: { agent: DesktopAgent; session: DesktopSession }[] = []
    const seen = new Set<string>()
    for (const agent of agents) {
        if (signal.aborted) { unavailable.add(agent.id); continue }
        try {
            for (const session of await listDesktopSessions(db, agent.id)) {
                if (session.agentId !== agent.id || seen.has(session.id)) continue
                seen.add(session.id)
                tasks.push({ agent, session })
            }
        } catch { unavailable.add(agent.id) }
    }
    const items: DesktopAttentionItem[] = []
    let next = 0
    await Promise.all(Array.from({ length: Math.min(DESKTOP_ATTENTION_CONCURRENCY, tasks.length) }, async () => {
        for (;;) {
            if (signal.aborted) return
            const task = tasks[next++]
            if (!task) return
            const { agent, session } = task
            let pending: Pick<DesktopAttentionItem, 'id' | 'kind' | 'summary' | 'requestedAt'> | undefined
            let failed = false
            try {
                // Sequential resolvers preserve the workspace-wide bound of four active
                // history reads. Both already exclude accepted answer/decision receipts.
                const { question } = await readDesktopQuestion(runtime, session.id, { signal })
                if (question) pending = { id: question.id, kind: 'question', summary: summary(question.questions[0].question), requestedAt: question.requestedAt ?? undefined }
                else {
                    signal.throwIfAborted()
                    const { approval } = await readDesktopApproval(runtime, session.id, { signal })
                    if (approval) pending = { id: approval.id, kind: 'approval', summary: summary(approval.approvals[0].action), requestedAt: approval.requestedAt ?? undefined }
                }
            } catch { failed = true }
            try {
                // Deletion or reassignment during a slow engine read must not publish its
                // old navigation target. A missing engine chat with a live local row is an
                // unavailable read, not evidence that its request has been resolved.
                const current = await findDesktopSession(db, session.id)
                if (!current || current.agentId !== agent.id || current.engineSessionId !== session.engineSessionId) continue
                await assertCoworkerNotDeleting(db, agent.id)
                if (failed) unavailable.add(agent.id)
                else if (pending) items.push({ ...pending, agentId: agent.id, agentName: agent.name, agentEnabled: agent.enabled,
                    sessionId: current.id, title: current.title, updatedAt: current.updatedAt })
            } catch { unavailable.add(agent.id) }
        }
    }))
    // Exhausting the whole-scan budget cancels active fetches and starts no more chats.
    // Owners not reached by the four workers remain explicitly unknown, never idle.
    for (const { agent } of tasks.slice(next)) unavailable.add(agent.id)
    // Refresh local labels and remove coworkers deleted while the scan was in flight.
    const currentAgents = new Map((await listDesktopAgents(db)).filter(agent => agent.workspaceId === 1).map(agent => [agent.id, agent]))
    const ownedItems: DesktopAttentionItem[] = []
    for (const item of items) {
        const agent = currentAgents.get(item.agentId)
        if (!agent) continue
        try {
            const current = await findDesktopSession(db, item.sessionId)
            const original = tasks.find(task => task.session.id === item.sessionId)
            if (!current || current.agentId !== agent.id || current.engineSessionId !== original?.session.engineSessionId) continue
            await assertCoworkerNotDeleting(db, agent.id)
            ownedItems.push({ ...item, agentName: agent.name, agentEnabled: agent.enabled, title: current.title, updatedAt: current.updatedAt,
                // A request without its own timestamp ages by the chat that raised it.
                requestedAt: item.requestedAt ?? current.updatedAt })
        } catch { unavailable.add(agent.id) }
    }
    // Newest request first: the source request message's own timestamp, never the chat activity.
    ownedItems.sort((a, b) => time(b.requestedAt ?? b.updatedAt) - time(a.requestedAt ?? a.updatedAt) || a.agentId.localeCompare(b.agentId) || a.sessionId.localeCompare(b.sessionId) || a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id))
    return { items: ownedItems, unavailableAgentIds: [...unavailable].filter(id => currentAgents.has(id)).sort(), checkedAt: new Date().toISOString() }
}

// Route bundles share this process-global in-flight read. Completed snapshots are never
// cached: an answer, deletion or explicit refresh starts a fresh scan on the next request.
// This is a read snapshot, not an admission decision; the opened chat revalidates the card.
export function readDesktopAttention(runtime: DesktopRuntime): Promise<DesktopAttention> {
    const key = JSON.stringify([resolve(runtime.dataRoot), runtime.launchNonce, runtime.engine.origin])
    const reads = shared.desktopAttentionReads ??= new Map()
    const pending = reads.get(key)
    if (pending) return pending
    const work = collect(runtime)
    reads.set(key, work)
    const release = () => { if (reads.get(key) === work) reads.delete(key) }
    void work.then(release, release)
    return work
}

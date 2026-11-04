import { afterEach, beforeEach } from 'vitest'
import { resetDesktopRecentCoworkers } from '@/lib/desktop/recent-coworkers'
import { desktopRecentCoworkerVisitSchema, desktopRecentCoworkersSchema, type DesktopRecentCoworkers, type DesktopRecentCoworkerVisit } from '@/lib/desktop/recent-coworkers.schema'

beforeEach(resetDesktopRecentCoworkers)
afterEach(resetDesktopRecentCoworkers)

/** Stateful endpoint support for App fixtures; unrelated methods and URLs remain unexpected. */
export function createDesktopRecentFixture(initial: DesktopRecentCoworkers = { revision: 0, recentAgentIds: [] }) {
    let saved = desktopRecentCoworkersSchema.parse(initial)
    let lastRequest: DesktopRecentCoworkerVisit | undefined
    const snapshot = (): DesktopRecentCoworkers => ({ revision: saved.revision, recentAgentIds: [...saved.recentAgentIds] })
    return {
        snapshot,
        handle(input: RequestInfo | URL, init?: RequestInit): Response | undefined {
            const url = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url, 'http://127.0.0.1')
            if (url.pathname !== '/api/desktop/recent-coworkers' || url.search || init?.method !== 'POST') return
            const visit = desktopRecentCoworkerVisitSchema.parse(JSON.parse(String(init.body)))
            if (lastRequest?.requestId === visit.requestId) {
                if (lastRequest.agentId !== visit.agentId || lastRequest.baseRevision !== visit.baseRevision) {
                    return Response.json({ error: 'That visit belongs to a different request' }, { status: 409 })
                }
                return Response.json(snapshot())
            }
            if (visit.baseRevision !== saved.revision) {
                return Response.json({ error: 'Recent coworkers changed. Try again.', recent: snapshot() }, { status: 409 })
            }
            saved = { revision: saved.revision + 1, recentAgentIds: [visit.agentId, ...saved.recentAgentIds.filter(id => id !== visit.agentId)].slice(0, 5) }
            lastRequest = visit
            return Response.json(snapshot())
        },
    }
}

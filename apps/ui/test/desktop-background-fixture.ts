import { normalizeNotificationPrefs } from '@rerun/contracts'

/** Neutral reads for newly mounted chat surfaces. Call after feature-specific handlers so
 * notification/skill tests keep their own state and every unexpected write still fails. */
export function desktopBackgroundRead(input: RequestInfo | URL, init?: RequestInit): Response | undefined {
    if ((init?.method ?? 'GET') !== 'GET') return
    const url = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url, 'http://local')
    if (/^\/api\/desktop\/coworkers\/[^/]+\/native-writeback$/.test(url.pathname)) return Response.json({ files: [] })
    if (url.pathname === '/api/desktop/notifications') return Response.json(normalizeNotificationPrefs(undefined))
    if (url.pathname === '/api/desktop/notifications/events') return Response.json({ events: [], channels: { toast: false, sound: false }, unavailableAgentIds: [], checkedAt: '2026-11-05T00:00:00Z' })
    if (/^\/api\/desktop\/agents\/[^/]+\/skills$/.test(url.pathname)) return Response.json({ skills: [] })
}

/** No proposals in tests that exercise a different chat surface; writes still reach their handler. */
export function desktopNativeReviewRead(input: RequestInfo | URL, init?: RequestInit): Response | undefined {
    if ((init?.method ?? 'GET') !== 'GET') return
    const url = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url, 'http://local')
    if (/^\/api\/desktop\/coworkers\/[^/]+\/native-writeback$/.test(url.pathname)) return Response.json({ files: [] })
}

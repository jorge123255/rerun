import { normalizeNotificationPrefs } from '@rerun/contracts'

/** Neutral reads for newly mounted chat surfaces. Call after feature-specific handlers so
 * notification/skill tests keep their own state and every unexpected write still fails. */
export function desktopBackgroundRead(input: RequestInfo | URL, init?: RequestInit): Response | undefined {
    if ((init?.method ?? 'GET') !== 'GET') return
    const url = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url, 'http://local')
    const setup = url.pathname.match(/^\/api\/desktop\/coworkers\/([^/]+)\/setup$/)
    if (setup) return Response.json({agentId:decodeURIComponent(setup[1]),revision:'fixture-setup',required:false,prompt:'',completedAt:null,sessionId:null,pending:false,skipped:false,defaultPrompt:''})
    if (/^\/api\/desktop\/sessions\/[^/]+\/service-requests$/.test(url.pathname)) return Response.json({request:null})
    if (/^\/api\/desktop\/sessions\/[^/]+\/takeover$/.test(url.pathname)) return Response.json({takeover:null})
    if (/^\/api\/desktop\/coworkers\/[^/]+\/mentions$/.test(url.pathname)) return Response.json({targets:[]})
    if (/^\/api\/desktop\/agents\/[^/]+\/sessions\/[^/]+\/browser-run$/.test(url.pathname)) return Response.json({trusted:null})
    if (/^\/api\/desktop\/coworkers\/[^/]+\/native-writeback$/.test(url.pathname)) return Response.json({ files: [] })
    if (url.pathname === '/api/desktop/notifications') return Response.json(normalizeNotificationPrefs(undefined))
    if (url.pathname === '/api/desktop/notifications/events') return Response.json({ events: [], channels: { toast: false, sound: false }, unavailableAgentIds: [], checkedAt: '2026-11-05T00:00:00Z' })
    if (/^\/api\/desktop\/agents\/[^/]+\/skills$/.test(url.pathname)) return Response.json({ skills: [] })
}

/** No proposals in tests that exercise a different chat surface; writes still reach their handler. */
export function desktopNativeReviewRead(input: RequestInfo | URL, init?: RequestInit): Response | undefined {
    if ((init?.method ?? 'GET') !== 'GET') return
    const url = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url, 'http://local')
    const setup = url.pathname.match(/^\/api\/desktop\/coworkers\/([^/]+)\/setup$/)
    if (setup) return Response.json({agentId:decodeURIComponent(setup[1]),revision:'fixture-setup',required:false,prompt:'',completedAt:null,sessionId:null,pending:false,skipped:false,defaultPrompt:''})
    if (/^\/api\/desktop\/sessions\/[^/]+\/service-requests$/.test(url.pathname)) return Response.json({request:null})
    if (/^\/api\/desktop\/sessions\/[^/]+\/takeover$/.test(url.pathname)) return Response.json({takeover:null})
    if (/^\/api\/desktop\/coworkers\/[^/]+\/mentions$/.test(url.pathname)) return Response.json({targets:[]})
    if (/^\/api\/desktop\/agents\/[^/]+\/sessions\/[^/]+\/browser-run$/.test(url.pathname)) return Response.json({trusted:null})
    if (/^\/api\/desktop\/coworkers\/[^/]+\/native-writeback$/.test(url.pathname)) return Response.json({ files: [] })
}

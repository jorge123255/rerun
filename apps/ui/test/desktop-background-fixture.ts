import { normalizeNotificationPrefs } from '@rerun/contracts'

/** Neutral reads for mounted desktop surfaces. Call after feature-specific handlers so
 * notification/skill tests keep their own state and every unexpected write still fails. */
export function desktopBackgroundRead(input: RequestInfo | URL, init?: RequestInit): Response | undefined {
    if ((init?.method ?? 'GET') !== 'GET') return
    const url = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url, 'http://local')
    if (url.pathname === '/api/desktop/subscription-login') return Response.json({
        'grok-build': { phase: 'unavailable' }, 'kimi-code': { phase: 'unavailable' },
    })
    // The workspace menu reads the Vault as it opens, for the mark on its Vault row.
    // The board counts down to the next routine; a workspace without one has nothing to show.
    if (url.pathname === '/api/desktop/workspace/routines/upcoming') return Response.json([])
    if (url.pathname === '/api/desktop/workspace-view') return Response.json({ view: null, lastOpened: null })
    if (url.pathname === '/api/desktop/vault') return Response.json({ entries: [], coworkers: [] })
    if (/^\/api\/desktop\/coworkers\/[^/]+\/document-attachments$/.test(url.pathname)) return Response.json({ attachments: [] })
    if (/^\/api\/desktop\/sessions\/[^/]+\/trigger-requests$/.test(url.pathname)) return Response.json({ request: null })
    if (url.pathname === '/api/desktop/foreman') {
        const chat = { workspaceId: '1', chatId: 'fmc_background-fixture' }
        return Response.json({ chat, sessionId: 'foreman-background-fixture', model: null, messages: [],
            view: { contractVersion: 1, chat, phase: 'plan', live: null, revisions: [], currentRevisionId: null, decisions: [], build: null, discovery: null, blocked: null },
            ui: { revision: 0, snapshot: null } })
    }
    if (/^\/api\/desktop\/sessions\/[^/]+\/mcp-sign-in$/.test(url.pathname)) return Response.json({ request: null })
    if (/^\/api\/desktop\/sessions\/[^/]+\/tool-install$/.test(url.pathname) && url.searchParams.get('pending') === '1') return Response.json({ installations: [], more: false })
    if (/^\/api\/desktop\/coworkers\/[^/]+\/schedule-tool-notices$/.test(url.pathname)) return Response.json({ notices: [] })
    const setup = url.pathname.match(/^\/api\/desktop\/coworkers\/([^/]+)\/setup$/)
    if (/^\/api\/desktop\/coworkers\/[^/]+\/voice$/.test(url.pathname) && !url.searchParams.has('attemptId')) return Response.json({ drafts: [] })
    if (/^\/api\/desktop\/coworkers\/[^/]+\/semantic-memory$/.test(url.pathname)) return Response.json({ mode: 'keyword-only', backend: null, indexed: 0, pending: 0, omitted: 0, detail: 'Keyword search is available.' })
    if (setup) return Response.json({agentId:decodeURIComponent(setup[1]),revision:'fixture-setup',required:false,prompt:'',completedAt:null,sessionId:null,pending:false,skipped:false,defaultPrompt:''})
    if (/^\/api\/desktop\/sessions\/[^/]+\/service-requests$/.test(url.pathname)) return Response.json({request:null})
    if (/^\/api\/desktop\/sessions\/[^/]+\/secret-requests$/.test(url.pathname)) return Response.json({request:null})
    if (/^\/api\/desktop\/sessions\/[^/]+\/takeover$/.test(url.pathname)) return Response.json({takeover:null})
    if (/^\/api\/desktop\/coworkers\/[^/]+\/mentions$/.test(url.pathname)) return Response.json({targets:[]})
    if (/^\/api\/desktop\/agents\/[^/]+\/sessions\/[^/]+\/browser-run$/.test(url.pathname)) return Response.json({trusted:null})
    if (/^\/api\/desktop\/agents\/[^/]+\/sessions\/[^/]+\/computer-panel$/.test(url.pathname)) return Response.json({
        workspaceId: '1', current: null, generation: null, coworker: { enabled: true, deleted: false }, takeover: null,
        runtime: { kind: 'container-stopped' }, grants: { computer: false, browser: false, terminalLaunch: false, filesLaunch: false },
        capability: { terminalInstalled: false, filesInstalled: false }, humanDriving: false, pending: null,
    })
    if (/^\/api\/desktop\/coworkers\/[^/]+\/native-writeback$/.test(url.pathname)) return Response.json({ files: [] })
    if (url.pathname === '/api/desktop/notifications') return Response.json(normalizeNotificationPrefs(undefined))
    if (url.pathname === '/api/desktop/notifications/events') return Response.json({ events: [], channels: { toast: false, sound: false }, unavailableAgentIds: [], checkedAt: '2026-11-05T00:00:00Z' })
    if (/^\/api\/desktop\/agents\/[^/]+\/skills$/.test(url.pathname)) return Response.json({ skills: [] })
}

/** No proposals in tests that exercise a different chat surface; writes still reach their handler. */
export function desktopNativeReviewRead(input: RequestInfo | URL, init?: RequestInit): Response | undefined {
    if ((init?.method ?? 'GET') !== 'GET') return
    const url = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url, 'http://local')
    if (/^\/api\/desktop\/coworkers\/[^/]+\/document-attachments$/.test(url.pathname)) return Response.json({ attachments: [] })
    if (/^\/api\/desktop\/sessions\/[^/]+\/trigger-requests$/.test(url.pathname)) return Response.json({ request: null })
    if (url.pathname === '/api/desktop/foreman') {
        const chat = { workspaceId: '1', chatId: 'fmc_background-fixture' }
        return Response.json({ chat, sessionId: 'foreman-background-fixture', model: null, messages: [],
            view: { contractVersion: 1, chat, phase: 'plan', live: null, revisions: [], currentRevisionId: null, decisions: [], build: null, discovery: null, blocked: null },
            ui: { revision: 0, snapshot: null } })
    }
    if (/^\/api\/desktop\/sessions\/[^/]+\/mcp-sign-in$/.test(url.pathname)) return Response.json({ request: null })
    if (/^\/api\/desktop\/sessions\/[^/]+\/tool-install$/.test(url.pathname) && url.searchParams.get('pending') === '1') return Response.json({ installations: [], more: false })
    if (/^\/api\/desktop\/coworkers\/[^/]+\/schedule-tool-notices$/.test(url.pathname)) return Response.json({ notices: [] })
    const setup = url.pathname.match(/^\/api\/desktop\/coworkers\/([^/]+)\/setup$/)
    if (/^\/api\/desktop\/coworkers\/[^/]+\/voice$/.test(url.pathname) && !url.searchParams.has('attemptId')) return Response.json({ drafts: [] })
    if (/^\/api\/desktop\/coworkers\/[^/]+\/semantic-memory$/.test(url.pathname)) return Response.json({ mode: 'keyword-only', backend: null, indexed: 0, pending: 0, omitted: 0, detail: 'Keyword search is available.' })
    if (setup) return Response.json({agentId:decodeURIComponent(setup[1]),revision:'fixture-setup',required:false,prompt:'',completedAt:null,sessionId:null,pending:false,skipped:false,defaultPrompt:''})
    if (/^\/api\/desktop\/sessions\/[^/]+\/service-requests$/.test(url.pathname)) return Response.json({request:null})
    if (/^\/api\/desktop\/sessions\/[^/]+\/secret-requests$/.test(url.pathname)) return Response.json({request:null})
    if (/^\/api\/desktop\/sessions\/[^/]+\/takeover$/.test(url.pathname)) return Response.json({takeover:null})
    if (/^\/api\/desktop\/coworkers\/[^/]+\/mentions$/.test(url.pathname)) return Response.json({targets:[]})
    if (/^\/api\/desktop\/agents\/[^/]+\/sessions\/[^/]+\/browser-run$/.test(url.pathname)) return Response.json({trusted:null})
    if (/^\/api\/desktop\/agents\/[^/]+\/sessions\/[^/]+\/computer-panel$/.test(url.pathname)) return Response.json({
        workspaceId: '1', current: null, generation: null, coworker: { enabled: true, deleted: false }, takeover: null,
        runtime: { kind: 'container-stopped' }, grants: { computer: false, browser: false, terminalLaunch: false, filesLaunch: false },
        capability: { terminalInstalled: false, filesInstalled: false }, humanDriving: false, pending: null,
    })
    if (/^\/api\/desktop\/coworkers\/[^/]+\/native-writeback$/.test(url.pathname)) return Response.json({ files: [] })
}

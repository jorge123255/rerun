import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DesktopActivityRecord } from '@rerun/contracts'

const agents = [
    { id: 'app-scout', engineAgentId: 'eng-scout', name: 'Scout' },
    { id: 'app-ledger', engineAgentId: 'eng-ledger', name: 'Ledger' },
]
vi.mock('server-only', () => ({}))
vi.mock('./store', () => ({ listDesktopAgents: async () => agents }))
const { clearDesktopActivity, engineActivityQuery, exportDesktopActivity, readDesktopActivity } = await import('./activity')

const engine = { baseUrl: 'http://127.0.0.1:1', apiKey: 'test-key' }
const record = (seq: number, overrides: Partial<DesktopActivityRecord> = {}) => ({
    seq, id: `r${seq}`, at: '2026-11-16T09:00:00.000Z', agentId: 'eng-scout', sessionId: 'eng-session-1', runId: 'run-1', source: 'chat', sourceSlug: null, tool: 'GMAIL_SEND_EMAIL', action: null,
    app: 'Gmail', kind: 'send', outcome: 'allowed-once-by-person', rule: 'ask-first:send', durationMs: 12, summary: 'to: pat@example.test', ...overrides,
})
const db = { execute: vi.fn(async (statement: unknown) => {
    const args = (statement as { args: string[] }).args
    return { rows: args.includes('eng-session-1') ? [{ id: 'app-session-1', engine_session_id: 'eng-session-1' }] : [] }
}) } as never
function engineAnswers(...pages: unknown[]) {
    const urls: string[] = [], methods: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => { urls.push(String(url)); methods.push(init?.method ?? 'GET'); return Response.json(pages.shift() ?? { records: [], next: null, total: 0, dropped: 0 }) }))
    return { urls, methods }
}
afterEach(() => { vi.unstubAllGlobals() })

describe('the view’s filters become the engine’s', () => {
    it('maps a coworker to its engine id, and deleted coworkers to everyone else', () => {
        expect(engineActivityQuery(new URLSearchParams('coworker=app-ledger&outcome=failed&source=routine&risky=1&q=%20mail%20'), agents as never).toString())
            .toBe('agents=eng-ledger&outcomes=failed&sources=routine&risky=1&q=mail')
        expect(engineActivityQuery(new URLSearchParams('coworker=deleted'), agents as never).get('except')).toBe('eng-scout,eng-ledger,foreman')
        // A coworker the app does not know matches nothing rather than everything.
        expect(engineActivityQuery(new URLSearchParams('coworker=unknown'), agents as never).get('agents')).toBe('')
        expect(engineActivityQuery(new URLSearchParams('outcome=nonsense&source=x&from=garbage&to=2026-11-16T23:59:59.999Z'), agents as never).toString()).toBe('to=2026-11-16T23%3A59%3A59.999Z')
    })
})

describe('rows as the owner reads them', () => {
    it('names the coworker and the saved conversation, in a sentence', async () => {
        const { urls } = engineAnswers({ records: [record(2), record(1, { agentId: 'eng-ledger', tool: 'shared_edit', app: null, kind: null, outcome: 'refused-no-permission', rule: 'permission:sharedFilesWrite', sessionId: 'eng-session-x', source: 'routine', sourceSlug: 'books' })], next: 1, total: 7, dropped: 2 })
        const view = await readDesktopActivity(engine, db, new URLSearchParams('coworker=app-scout&before=9'))
        expect(urls[0]).toBe('http://127.0.0.1:1/desktop/activity?agents=eng-scout&before=9')
        expect(view).toMatchObject({ next: 1, total: 7, dropped: 2, coworkers: [{ id: 'app-scout', name: 'Scout' }, { id: 'app-ledger', name: 'Ledger' }] })
        expect(view.rows[0]).toMatchObject({ coworker: 'Scout', coworkerId: 'app-scout', deleted: false, conversationId: 'app-session-1', sentence: 'Scout sent email with Gmail: allowed once by you', ruleWords: 'Ask first: sending to other people' })
        expect(view.rows[1]).toMatchObject({ coworker: 'Ledger', conversationId: null, sentence: 'Ledger was refused: Edit shared files is off', ruleWords: 'Permission: Edit shared files', source: 'routine', sourceSlug: 'books' })
    })

    it('keeps a deleted coworker’s rows and shows them as a deleted coworker, with nothing to open', async () => {
        engineAnswers({ records: [record(3, { agentId: 'eng-gone' }), record(2, { agentId: 'foreman', tool: 'fs_read', app: null, kind: null, outcome: 'completed', rule: null }), record(1, { agentId: 'eng-helper', source: 'delegated', tool: 'web_fetch', app: null, kind: null, outcome: 'failed', rule: null })], next: null, total: 3, dropped: 0 })
        const view = await readDesktopActivity(engine, db, new URLSearchParams())
        expect(view.rows[0]).toMatchObject({ coworker: 'Deleted coworker', coworkerId: null, deleted: true, conversationId: null, sentence: 'Deleted coworker sent email with Gmail: allowed once by you' })
        expect(view.rows[1]).toMatchObject({ coworker: 'Chief of Staff', deleted: false, sentence: 'Chief of Staff read a file: done' })
        expect(view.rows[2]).toMatchObject({ coworker: 'A helper', deleted: false, sentence: 'A helper tried to read a web page: it failed' })
    })
})

describe('export and clear', () => {
    it('exports every page of the current filter as CSV, with the same redacted fields', async () => {
        const { urls } = engineAnswers(
            { records: [record(3, { summary: 'subject: "Q3, final"' }), record(2, { agentId: 'eng-gone' })], next: 2, total: 3, dropped: 0 },
            { records: [record(1, { tool: '=cmd', app: null, kind: null })], next: null, total: 3, dropped: 0 },
        )
        const csv = await exportDesktopActivity(engine, db, new URLSearchParams('risky=1'))
        expect(urls).toEqual(['http://127.0.0.1:1/desktop/activity?risky=1&limit=500', 'http://127.0.0.1:1/desktop/activity?risky=1&limit=500&before=2'])
        const lines = csv.trimEnd().split('\r\n')
        expect(lines).toHaveLength(4)
        expect(lines[0]!.startsWith('time,coworker,coworker_id,what,outcome,rule,tool')).toBe(true)
        expect(lines[1]).toContain('"subject: ""Q3, final"""')
        expect(lines[2]).toContain('Deleted coworker,eng-gone,Deleted coworker sent email with Gmail: allowed once by you')
        expect(lines[3]).toContain(",'=cmd,")
    })

    it('clears through the engine', async () => {
        const { urls, methods } = engineAnswers({ cleared: true })
        await clearDesktopActivity(engine)
        expect([urls, methods]).toEqual([['http://127.0.0.1:1/desktop/activity'], ['DELETE']])
    })
})

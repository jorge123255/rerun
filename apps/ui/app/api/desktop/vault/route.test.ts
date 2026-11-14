import { beforeEach, expect, test, vi } from 'vitest'
import type { DesktopVaultListing, DesktopVaultMutation } from '@/lib/desktop/vault'

const state = vi.hoisted(() => ({
    entries: [] as DesktopVaultListing['entries'],
    mutations: [] as DesktopVaultMutation[],
    checks: [] as string[],
    receipt: null as null | { state: string; credentialRejected?: true } | Error,
}))
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const account = (n: number, hasBearer = true) => ({ id: id(n), revision: id(100 + n), name: 'agentmail', kind: 'mcp' as const, url: 'https://mcp.agentmail.to/mcp', hasBearer,
    catalog: { slug: 'agentmail', methodId: 'api-key', name: 'AgentMail' }, agentIds: [], sharedWithAll: false })

vi.mock('server-only', () => ({}))
vi.mock('@/lib/desktop/server/http', () => ({ desktopRoute: async (_request: Request, run: (runtime: object) => Promise<Response>) => {
    try { return await run({}) } catch (error) { return Response.json({ error: (error as Error).message }, { status: (error as { status?: number }).status ?? 500 }) }
} }))
vi.mock('@/lib/desktop/server/workspace-admission', () => ({ assertDesktopWorkspaceAdmission: () => {} }))
vi.mock('@/lib/desktop/server/request-json', () => ({ readDesktopJson: (request: Request) => request.json() }))
vi.mock('@/lib/desktop/server/vault/binding', () => ({ openDesktopVault: async () => ({
    list: async () => ({ entries: [...state.entries], coworkers: [] }),
    mutate: async (change: DesktopVaultMutation) => {
        state.mutations.push(change)
        if (change.operation === 'add-app') state.entries.push(account(state.entries.length + 1, change.methodId === 'api-key'))
        if (change.operation === 'delete') state.entries = state.entries.filter(entry => entry.id !== change.id)
        return { entries: [...state.entries], coworkers: [] }
    },
}) }))
vi.mock('@/lib/desktop/server/mcp-binding', () => ({ getDesktopRemoteMcpService: async () => ({
    checkVaultCatalogHealth: async (entry: string) => { state.checks.push(entry); if (state.receipt instanceof Error) throw state.receipt; return state.receipt },
}) }))

const add = (methodId = 'api-key') => import('./route').then(({ POST }) => POST(new Request('http://127.0.0.1/api/desktop/vault', { method: 'POST',
    body: JSON.stringify({ operation: 'add-app', slug: 'agentmail', methodId, values: { AGENTMAIL_API_KEY: 'synthetic-key' } }) })))

beforeEach(() => { state.entries = [account(1)]; state.mutations = []; state.checks = []; state.receipt = null })

test('an account whose key the app refuses is removed again and the person is told which app refused it', async () => {
    state.receipt = { state: 'error', credentialRejected: true }
    const response = await add()
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'AgentMail refused this key. Check you copied the right one from AgentMail, then try again.' })
    expect(state.checks).toEqual([id(2)])
    expect(state.mutations.map(change => change.operation)).toEqual(['add-app', 'delete'])
    // Only the account this request added is undone.
    expect(state.entries.map(entry => entry.id)).toEqual([id(1)])
})

test.each([
    ['accepts the key', { state: 'healthy' }],
    ['does not answer', { state: 'error' }],
    ['cannot be checked', new Error('offline')],
] as const)('the account stays when the app %s', async (_case, receipt) => {
    state.receipt = receipt as typeof state.receipt
    const response = await add()
    expect(response.status).toBe(200)
    expect((await response.json()).entries).toHaveLength(2)
    expect(state.mutations.map(change => change.operation)).toEqual(['add-app'])
})

test('an account saved without a key is not dialed', async () => {
    const response = await add('oauth')
    expect(response.status).toBe(200)
    expect(state.checks).toEqual([])
})

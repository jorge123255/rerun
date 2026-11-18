import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { macPhoneCoworkerSettingsChangeSchema, macPhoneCoworkerSettingsSchema } from '@rerun/contracts'
import { GET } from './route'
import { GET as readField, PATCH } from './[field]/route'
import { phoneSettingsMethods } from '@/lib/desktop/server/phone-coworker-settings'

const fixture = vi.hoisted(() => ({
    origin: 'http://127.0.0.1:1234', token: 'fixture-app-cookie',
    id: '11111111-1111-4111-8111-111111111111', box: '22222222-2222-4222-8222-222222222222',
    request: '33333333-3333-4333-8333-333333333333', peer: '44444444-4444-4444-8444-444444444444',
}))
vi.mock('@/lib/desktop/server/runtime', async original => ({ ...await original<object>(), readDesktopRuntime: async () => ({
    workspaceId: 7, launchNonce: 'fixture', dataRoot: '/unused', app: { origin: fixture.origin, sessionToken: fixture.token },
}) }))
vi.mock('@/lib/desktop/server/database', () => ({ openDesktopDatabase: async () => ({}) }))
vi.mock('@/lib/desktop/server/store', () => ({
    findDesktopAgent: async (_db: unknown, id: string) => id === fixture.id ? { id, workspaceId: 1, name: 'Ada', enabled: true, description: 'Local job', engineAgentId: 'PRIVATE-engine-name' } : null,
}))

const actions: { path: string; method: string; body: unknown }[] = []
let selectedProvider = 'codex', presetProvider: string | undefined, callsOn = true
let claudeRows: (ReturnType<typeof row> & { unavailableReason?: string })[] | undefined
let refusal: { status: number; error: string } | null = null
const secret = 'PRIVATE-stored-value'
function row(id: string, enabled = false) { return { id, label: id, description: 'Mac row description', enabled, available: true, internalDetail: secret } }
function answer(path: string) {
    if (path.endsWith('/settings')) return { soul: 'Write code.', verbosity: 'normal', soulEditable: true, workspaceReadEnabled: false, suggestedReplies: true,
        memoryEnabled: false, autoMemory: false, selfImprovementEnabled: false, repository: { owner: 'example', name: 'app', url: 'https://user:' + secret + '@example.test' }, vault: secret }
    if (path.endsWith('/model?presets=1')) return { catalog: [{ provider: 'codex', name: 'Local', connectionId: 'provider-1', apiKey: secret, models: [{ id: 'current', label: 'Current' }] }],
        workspace: null, coworker: null, conversation: null, effective: { connectionId: 'provider-1', provider: selectedProvider, presetProvider, source: 'workspace', name: 'Local', model: 'current', label: 'Current', available: true } }
    if (path.endsWith('/tools')) return { rerun: [row('callAgent', callsOn), row('localMcpStdio'), row('download')], codex: [row('codeMode'), row('images')], ...(claudeRows && { claude: claudeRows }) }
    if (path.endsWith('/call-targets')) return { targets: [{ agentId: fixture.peer, name: 'Peer', enabled: true, callable: true, bearer: secret }], allowedTargetIds: [fixture.peer] }
    if (path === '/spaces') return { board: { revision: 4, spaces: [{ id: fixture.box, name: 'Box A', col_start: 0, row_start: 0, col_end: 6, row_end: 6 }],
        placements: [{ agentId: fixture.id, spaceId: fixture.box, col: 1, row: 1 }] } }
    if (path.endsWith('/setup?observe=1')) return { agentId: fixture.id, revision: 'v1', required: true, canStart: true, canContinue: false, canSkip: true, prompt: secret, completedAt: null, sessionId: null, pending: true, skipped: false, defaultPrompt: secret }
    throw new Error('Unexpected canonical read ' + path)
}
beforeEach(() => {
    actions.length = 0; selectedProvider = 'codex'; presetProvider = undefined; claudeRows = undefined; callsOn = true; refusal = null
    vi.stubGlobal('fetch', vi.fn(async (url: URL, init: RequestInit) => {
        expect(url.origin).toBe(fixture.origin)
        expect(init.redirect).toBe('error')
        expect(new Headers(init.headers).get('cookie')).toBe('rerun-desktop-session=' + fixture.token)
        const path = url.pathname.replace('/api/desktop', '') + url.search, method = init.method ?? 'GET'
        actions.push({ path, method, body: init.body ? JSON.parse(String(init.body)) : null })
        return method === 'GET' ? Response.json(answer(path)) : refusal ? Response.json({ error: refusal.error }, { status: refusal.status }) : Response.json({ engineKey: secret })
    }))
})
afterEach(() => vi.unstubAllGlobals())

function request(method: string, field?: string, body?: unknown, id = fixture.id, cookie = fixture.token) {
    return new Request(fixture.origin + '/api/desktop/phone-pairing/coworker-settings' + (field ? '/' + field : '') + '?agentId=' + id, {
        method, headers: { host: '127.0.0.1:1234', origin: fixture.origin, cookie: 'rerun-desktop-session=' + cookie, 'content-type': 'application/json' },
        ...(body !== undefined && { body: JSON.stringify(body) }),
    })
}
function mutate(field: keyof typeof phoneSettingsMethods, body: unknown, id = fixture.id) {
    return PATCH(request(phoneSettingsMethods[field], field, body, id), { params: Promise.resolve({ field }) })
}

it('reads only the Mac-owned roster, settings and human-readable permissions; a phone never receives credentials, setup prompts or engine IDs', async () => {
    const result = await GET(request('GET'))
    expect(result.status).toBe(200)
    const view = await result.json()
    expect(view).not.toHaveProperty('permissions') // added only by the listener from its own device store
    expect(macPhoneCoworkerSettingsSchema.parse({ ...view, permissions: { changeSettings: false } })).toMatchObject({
        settings: { repository: 'example/app' }, board: { spaceId: fixture.box, revision: 4 },
        setup: { canStart: true, canSkip: true }, tools: { rerun: [{ confirmOnEnable: false }, { confirmOnEnable: true }, { confirmOnEnable: true }], codex: [{ confirmOnEnable: true }, { confirmOnEnable: true }] },
    })
    expect(JSON.stringify(view)).not.toContain('PRIVATE')
    expect(JSON.stringify(view)).not.toContain('https://')
    expect(view.setup).not.toHaveProperty('prompt')
    expect(view.model).not.toHaveProperty('conversation')
})

it('reads the scoped setup snapshot without fetching private instructions, tools or credentials', async () => {
    const context = { params: Promise.resolve({ field: 'setup' }) }
    expect((await readField(request('GET', 'setup', undefined, 'foreign'), context)).status).toBe(404)
    expect((await readField(request('GET', 'setup', undefined, fixture.id, 'expired'), context)).status).toBe(401)
    expect((await readField(request('GET', 'tools'), { params: Promise.resolve({ field: 'tools' }) })).status).toBe(404)
    expect(actions).toEqual([])
    const response = await readField(request('GET', 'setup'), context)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
        agentId: fixture.id, revision: 'v1', pending: true, skipped: false, required: true,
        canStart: true, canContinue: false, canSkip: true, sessionId: null, completedAt: null,
    })
    expect(actions.map(a => [a.method, a.path])).toEqual([
        ['GET', '/coworkers/' + fixture.id + '/setup?observe=1'],
        ['GET', '/agents/' + fixture.id + '/model?presets=1'],
    ])
})

const valid = [
    ['model', { action: 'coworker', connectionId: 'provider-1', model: 'current' }, '/agents/' + fixture.id + '/model'],
    ['model', { action: 'follow-workspace' }, '/agents/' + fixture.id + '/model'],
    ['effort', { connectionId: 'provider-1', model: 'current', effort: null }, '/model-effort'],
    ['tools', { group: 'rerun', id: 'localMcpStdio', enabled: true }, '/agents/' + fixture.id + '/tools'],
    ['tools', { group: 'codex', id: 'codeMode', enabled: false }, '/agents/' + fixture.id + '/tools'],
    ['call-targets', { targetAgentIds: [], expectedTargetAgentIds: [fixture.peer] }, '/coworkers/' + fixture.id + '/call-targets'],
    ['settings', { description: 'Changed', soul: 'New instructions', repository: 'example/app' }, '/agents/' + fixture.id + '/settings'],
    ['name', { name: 'New name' }, '/agents/' + fixture.id],
    ['enabled', { enabled: false }, '/agents/' + fixture.id + '/enabled'],
    ['setup', { action: 'start', requestId: fixture.request, expectedRevision: 'v1' }, '/coworkers/' + fixture.id + '/setup'],
    ['setup', { action: 'continue', requestId: fixture.request, expectedRevision: 'v1' }, '/coworkers/' + fixture.id + '/setup'],
    ['setup', { action: 'skip', requestId: fixture.request, expectedRevision: 'v1' }, '/coworkers/' + fixture.id + '/setup'],
] as const
it.each(valid)('%s uses the same route, method and body as the Mac and returns only an acknowledgement', async (field, body, target) => {
    const res = await mutate(field, body)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
    expect(actions.at(-1)).toEqual({ path: target, method: phoneSettingsMethods[field], body })
})
it('constructs only this coworker’s board move with the original request id and revision', async () => {
    const res = await mutate('box', { spaceId: fixture.box, requestId: fixture.request, expectedRevision: 17 })
    expect(res.status).toBe(200)
    expect(actions).toEqual([{ path: '/spaces', method: 'POST', body: { expectedRevision: 17, requestId: fixture.request, command: { kind: 'move-agent', agentId: fixture.id, spaceId: fixture.box } } }])
})
it('propagates a safe Mac refusal but never engine error bodies', async () => {
    refusal = { status: 409, error: 'Allowed coworkers changed. Reopen Tools before trying again.' }
    let res = await mutate('call-targets', { targetAgentIds: [], expectedTargetAgentIds: [fixture.peer] })
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: 'settings_refused', message: refusal.error })
    refusal = { status: 502, error: secret }
    res = await mutate('name', { name: 'Ada' })
    expect(res.status).toBe(502)
    expect(await res.text()).not.toContain(secret)
})

it('requires the current workspace cookie and local coworker before reading or mutating', async () => {
    expect((await GET(request('GET', undefined, undefined, fixture.id, 'old-workspace'))).status).toBe(401)
    expect((await GET(request('GET', undefined, undefined, 'foreign'))).status).toBe(404)
    expect((await mutate('name', { name: 'Other' }, 'foreign')).status).toBe(404)
    expect(actions).toEqual([])
})
it('uses the live provider behind a preset on reads and rechecks it on Codex tool writes', async () => {
    selectedProvider = 'rerun'
    presetProvider = 'codex'
    expect((await (await GET(request('GET'))).json()).tools.codex).toHaveLength(2)
    expect((await mutate('tools', { group: 'codex', id: 'shell', enabled: true })).status).toBe(200)
    presetProvider = 'claude'
    expect((await mutate('tools', { group: 'codex', id: 'shell', enabled: true })).status).toBe(409)
    expect((await (await GET(request('GET'))).json()).tools.codex).toEqual([])
})
it('refuses other effort targets, non-Codex tool requests and calls behind an off master', async () => {
    selectedProvider = 'claude'; callsOn = false
    expect((await mutate('effort', { connectionId: 'wrong', model: 'current', effort: null })).status).toBe(409)
    expect((await mutate('tools', { group: 'codex', id: 'shell', enabled: true })).status).toBe(409)
    expect((await mutate('call-targets', { targetAgentIds: [], expectedTargetAgentIds: [] })).status).toBe(409)
    expect(actions.every(a => a.method === 'GET')).toBe(true)
    expect((await (await GET(request('GET'))).json()).tools.codex).toEqual([])
})
it.each(['/private/etc', 'https://user:pass@github.com/owner/repo', 'https://github.com/owner/repo?token=private'])('rejects credential-bearing and local repository addresses', async repository => {
    expect((await mutate('settings', { repository })).status).toBe(400)
    expect(actions).toEqual([])
})
describe('the phone cannot provide a new route, a credential, or another identity in a settings body', () => {
    it.each([
        ['settings', { workspaceReadEnabled: true }], ['settings', { apiKey: 'fixture' }], ['settings', { password: 'fixture' }],
        ['model', { action: 'conversation-follow', sessionId: fixture.peer }], ['setup', { action: 'save', prompt: 'new' }],
        ['setup', { action: 'complete', requestId: fixture.request, expectedRevision: 'v1' }],
        ['setup', { action: 'continue', requestId: fixture.request, expectedRevision: 'v1', sessionId: fixture.peer }],
        ['box', { agentId: fixture.peer, requestId: fixture.request, expectedRevision: 1, spaceId: fixture.box }],
    ] as const)('rejects surplus or Mac-only inputs for %s', async (field, body) => {
        expect(macPhoneCoworkerSettingsChangeSchema.safeParse({ field, body }).success).toBe(false)
        expect((await mutate(field, body)).status).toBe(400)
        expect(actions).toEqual([])
    })
    it('refuses an unlisted field or a different method', async () => {
        expect((await PATCH(request('PATCH', 'vault', {}), { params: Promise.resolve({ field: 'vault' }) })).status).toBe(404)
        expect((await PATCH(request('POST', 'enabled', { enabled: false }), { params: Promise.resolve({ field: 'enabled' }) })).status).toBe(404)
        expect(actions).toEqual([])
    })
})

it('shows only the supported Claude permission when the Mac exposes it; an old Mac stays read-compatible and refuses edits', async () => {
    const read = async () => (await (await GET(request('GET'))).json()).tools
    expect(await read()).not.toHaveProperty('claude')
    const edit = () => mutate('tools', { group: 'claude', id: 'claudeSubagents', enabled: true })
    expect((await edit()).status).toBe(400)
    claudeRows = []
    expect((await read()).claude).toEqual([])
    expect((await edit()).status).toBe(400)
    claudeRows = [row('claudeSubagents'), row('futurePermission')]
    expect((await read()).claude).toEqual([expect.objectContaining({ id: 'claudeSubagents', description: 'Mac row description', confirmOnEnable: false })])
    expect((await mutate('tools', { group: 'claude', id: 'futurePermission', enabled: true })).status).toBe(400)
    expect((await mutate('tools', { group: 'rerun', id: 'claudeSubagents', enabled: true })).status).toBe(400)
    expect(actions.every(action => action.method === 'GET')).toBe(true)
    expect((await edit()).status).toBe(200)
    expect(actions.at(-1)).toEqual({ method: 'PATCH', path: '/agents/' + fixture.id + '/tools', body: { group: 'claude', id: 'claudeSubagents', enabled: true } })
})

it.each(['This permission requires a coworker using Claude Code with your Claude subscription.', 'This tool requires the direct Mac build.'])('preserves the Mac refusal and lets the owner revoke an existing Claude grant: %s', async reason => {
    claudeRows = [{ ...row('claudeSubagents', true), available: false, unavailableReason: reason }]
    const edit = (enabled: boolean) => mutate('tools', { group: 'claude', id: 'claudeSubagents', enabled })
    const view = await (await GET(request('GET'))).json()
    expect(view.tools.claude).toEqual([expect.objectContaining({ available: false, enabled: true, unavailableReason: reason })])
    const on = await edit(true)
    expect(on.status).toBe(400)
    expect(await on.json()).toEqual({ error: 'settings_refused', message: reason })
    expect(actions.every(action => action.method === 'GET')).toBe(true)
    expect((await edit(false)).status).toBe(200)
    const stopped = 'The permission could not change. Stop any active replies for this coworker and try again.'
    refusal = { status: 409, error: stopped }
    const busy = await edit(false)
    expect(busy.status).toBe(409)
    expect(await busy.json()).toEqual({ error: 'settings_refused', message: stopped })
})

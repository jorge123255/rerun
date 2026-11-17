import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createClient, type Client } from '@libsql/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

vi.mock('server-only', () => ({}))
const { readDesktopTeamChanges, recordDesktopTeamChanges, sealTeamChanges, settleDesktopTeamChanges, teamModelOptions } = await import('./team-changes')
const { sealShownPlan } = await import('./seal')
import type { TeamChangeWorkspace } from './team-changes'

const workspace: TeamChangeWorkspace = {
    coworkers: [{ id: 'a1', name: 'Tuner Developer' }, { id: 'a2', name: 'Server Developer' }, { id: 'a3', name: 'Twin' }, { id: 'a4', name: 'twin' }],
    connections: [
        { id: 'mac-chatgpt', name: 'ChatGPT (Codex)', provider: 'codex', connected: true, models: ['gpt-6-sol', 'gpt-6-luna'], extraModels: [], codexReasoning: { 'gpt-6-sol': { supported: ['low', 'high'], default: 'low' } } },
        { id: 'off', name: 'Claude', provider: 'claude', connected: false, models: ['claude-opus-5-5'], extraModels: [] },
    ] as never,
}
const line = (action: string, extra: Record<string, unknown> = {}) => ({ action, ...extra })

test('each line is resolved to a real coworker, permission and model, in the app\'s own words', () => {
    const sealed = sealTeamChanges({ summary: 'Get the team ready', changes: [
        line('switch_on', { coworker: 'tuner developer' }), line('allow', { coworker: 'Tuner Developer', permission: 'callAgent' }),
        line('give_github', { coworker: 'Server Developer' }), line('start_setup', { coworker: 'Server Developer' }),
        line('set_model', { coworker: 'Server Developer', connection: 'chatgpt (codex)', model: 'gpt-6-luna' }),
        line('set_effort', { connection: 'ChatGPT (Codex)', model: 'gpt-6-sol', effort: 'high' }),
        line('allow', { coworker: 'Tuner Developer', permission: 'githubWrite' }),
        // The same line twice is one line.
        line('switch_on', { coworker: 'Tuner Developer' }),
    ] }, workspace)
    if (!sealed.ok) throw new Error(sealed.message)
    expect(sealed.refused).toEqual([])
    expect(sealed.changes.map(change => [change.key, change.agentId, change.label])).toEqual([
        ['change-0', 'a1', 'Switch on Tuner Developer'], ['change-1', 'a1', 'Allow Tuner Developer: Call coworkers'],
        ['change-2', 'a2', 'Let Server Developer work on its GitHub repository'], ['change-3', 'a2', 'Start Server Developer\'s setup'],
        ['change-4', 'a2', 'Set Server Developer to answer with ChatGPT (Codex) · gpt-6-luna'], ['change-5', null, 'Set ChatGPT (Codex) · gpt-6-sol to high effort'],
        ['change-6', 'a1', 'Allow Tuner Developer: Change GitHub repositories'],
    ])
    // What reaches further than its words is said under the line.
    expect(sealed.changes[2]!.caution).toContain('no app from the Vault is given')
    expect(sealed.changes[5]!.caution).toContain('wherever this model runs')
    expect(sealed.changes[6]!.caution).toContain('still asks you first')
    expect(sealed.changes[4]).toMatchObject({ connectionId: 'mac-chatgpt', model: 'gpt-6-luna' })
})

test('a line that names nobody real, an unconnected provider, an unknown model or effort, or a permission outside the list is refused', () => {
    const sealed = sealTeamChanges({ summary: 'x', changes: [
        line('switch_on', { coworker: 'Nobody' }), line('switch_on', { coworker: 'Twin' }), line('switch_on'),
        line('set_model', { coworker: 'Tuner Developer', connection: 'Claude', model: 'claude-opus-5-5' }),
        line('set_model', { coworker: 'Tuner Developer', connection: 'ChatGPT (Codex)', model: 'gpt-9' }),
        line('set_effort', { connection: 'ChatGPT (Codex)', model: 'gpt-6-sol', effort: 'ultra' }),
        line('allow', { coworker: 'Tuner Developer' }), line('switch_off', { coworker: 'Server Developer' }),
    ] }, workspace)
    if (!sealed.ok) throw new Error(sealed.message)
    expect(sealed.changes.map(change => change.label)).toEqual(['Switch off Server Developer'])
    expect(sealed.refused).toEqual([
        'switch_on for "Nobody": no coworker has this name', 'switch_on for "Twin": more than one coworker has this name', 'switch_on: name the coworker',
        'set_model for "Tuner Developer": that provider is not connected', 'set_model for "Tuner Developer": that provider does not offer this model',
        'set_effort: that model does not offer this effort', 'allow for "Tuner Developer": name the permission',
    ])
    // A permission that reaches the Mac itself cannot even be named.
    expect(sealTeamChanges({ summary: 'x', changes: [line('allow', { coworker: 'Tuner Developer', permission: 'localMcpStdio' })] }, workspace).ok).toBe(false)
})

test('only connected providers, their models and efforts are offered, with no address or key', () => {
    expect(teamModelOptions(workspace.connections)).toEqual([{ connectionId: 'mac-chatgpt', name: 'ChatGPT (Codex)', models: [{ id: 'gpt-6-sol', efforts: ['low', 'high'] }, { id: 'gpt-6-luna', efforts: [] }] }])
})

let db: Client, dir: string
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'team-changes-')); db = createClient({ url: `file:${join(dir, 'app.db')}` }) })
afterEach(async () => { db.close(); await rm(dir, { recursive: true, force: true }) })
const chat = { workspaceId: '1', chatId: 'fmc_teamchanges0001' }
const binding = { ...chat, runId: '11111111-1111-4111-8111-111111111111', model: { connectionId: 'mac-chatgpt', model: 'gpt-6-sol' } } as never

test('a proposal is kept once for the card, tells the model nothing has changed, and is settled once by the person', async () => {
    const input = { summary: 'Switch the developer on', changes: [line('switch_on', { coworker: 'Tuner Developer' }), line('switch_on', { coworker: 'Nobody' })] }
    const first = await recordDesktopTeamChanges(db, binding, 'call-1', input, workspace)
    expect(first).toMatchObject({ shown: 1, refused: ['switch_on for "Nobody": no coworker has this name'] })
    expect(first.note).toContain('Nothing has changed yet')
    // The same tool call again shows the same card, not a second one.
    await recordDesktopTeamChanges(db, binding, 'call-1', input, workspace)
    expect((await db.execute('SELECT count(*) AS n FROM desktop_foreman_team_changes')).rows[0]!.n).toBe(1)
    const card = (await readDesktopTeamChanges(db, chat))!
    expect([card.state, card.changes.length, card.changes[0]!.result]).toEqual(['shown', 1, null])

    const applied = (await settleDesktopTeamChanges(db, chat, { id: card.id, state: 'applied', results: [{ key: 'change-0', ok: false, message: 'Coworker not found' }] }))!
    expect([applied.state, applied.changes[0]!.result]).toEqual(['applied', { ok: false, message: 'Coworker not found' }])
    // A settled card stays as it was settled, and another conversation cannot settle it.
    expect((await settleDesktopTeamChanges(db, chat, { id: card.id, state: 'dismissed', results: [] }))!.state).toBe('applied')
    expect(await settleDesktopTeamChanges(db, { ...chat, chatId: 'fmc_someoneelse0001' }, { id: card.id, state: 'dismissed', results: [] })).toBeNull()
    // A proposal with nothing usable shows no card.
    expect(await recordDesktopTeamChanges(db, binding, 'call-2', { summary: 'x', changes: [line('switch_on', { coworker: 'Nobody' })] }, workspace)).toMatchObject({ shown: 0 })
    expect((await readDesktopTeamChanges(db, chat))!.id).toBe(card.id)
})

test('a plan item keeps the model the person chose only when that provider is connected and offers it', () => {
    const agent = (name: string, extra = {}) => ({ kind: 'agent', name, role: 'Does the work', ...extra })
    const models = [{ connectionId: 'mac-chatgpt', name: 'ChatGPT (Codex)', models: ['gpt-6-sol'] }]
    const sealed = sealShownPlan({ title: 'More developers', items: [
        agent('Dev one', { provider: 'chatgpt (codex)', model: 'gpt-6-sol' }), agent('Dev two', { provider: 'ChatGPT (Codex)', model: 'gpt-9' }),
        agent('Dev three', { provider: 'Claude', model: 'claude-opus-5-5' }), agent('Dev four'),
    ] }, null, models)
    if (!sealed.ok) throw new Error(sealed.message)
    const items = sealed.plan.items as { name: string; chosenModel?: unknown; provider?: unknown; model?: unknown }[]
    expect(items.map(item => item.chosenModel ?? null)).toEqual([{ connectionId: 'mac-chatgpt', model: 'gpt-6-sol', name: 'ChatGPT (Codex)' }, null, null, null])
    // What the model wrote is never kept as such.
    for (const item of items) { expect(item.provider).toBeUndefined(); expect(item.model).toBeUndefined() }
})

test('a setup that is not waiting is refused before the card, and one that could not be read is left to the app', () => {
    const sealed = sealTeamChanges({ summary: 'Start setup', changes: [line('start_setup', { coworker: 'Tuner Developer' }), line('start_setup', { coworker: 'Server Developer' }), line('start_setup', { coworker: 'Twin Reader' })] }, {
        ...workspace, coworkers: [{ id: 'a1', name: 'Tuner Developer', setupWaiting: false }, { id: 'a2', name: 'Server Developer', setupWaiting: true }, { id: 'a5', name: 'Twin Reader' }],
    })
    if (!sealed.ok) throw new Error(sealed.message)
    expect(sealed.changes.map(change => change.coworker)).toEqual(['Server Developer', 'Twin Reader'])
    expect(sealed.refused).toEqual(['start_setup for "Tuner Developer": this coworker has no setup waiting to start'])
})

test('who may be asked is resolved to real coworkers, for a coworker, for everyone and for the Chief of Staff', () => {
    const sealed = sealTeamChanges({ summary: 'Let them work together', changes: [
        line('allow_calls', { coworker: 'Tuner Developer', targets: ['server developer'] }),
        line('allow_calls', { coworker: 'Server Developer', targets: ['everyone'] }),
        line('allow_calls', { coworker: 'Chief of Staff', targets: ['Tuner Developer', 'Tuner Developer'] }),
        line('allow_calls', { coworker: 'Tuner Developer', targets: ['Nobody Here'] }),
        line('allow_calls', { coworker: 'Tuner Developer', targets: ['Twin'] }),
        line('allow_calls', { coworker: 'Tuner Developer' }),
        line('allow_calls', { coworker: 'Tuner Developer', targets: ['Tuner Developer'] }),
    ] }, workspace)
    if (!sealed.ok) throw new Error(sealed.message)
    expect(sealed.changes.map(change => [change.label, change.agentId, change.chief, change.targetAgentIds])).toEqual([
        ['Let Tuner Developer ask Server Developer for help', 'a1', false, ['a2']],
        ['Let Server Developer ask Tuner Developer, Twin, twin for help', 'a2', false, ['a1', 'a3', 'a4']],
        ['Let the Chief of Staff ask Tuner Developer for help', null, true, ['a1']],
    ])
    expect(sealed.refused).toEqual([
        'allow_calls for "Tuner Developer": "Nobody Here" is not the name of exactly one other coworker',
        'allow_calls for "Tuner Developer": "Twin" is not the name of exactly one other coworker',
        'allow_calls for "Tuner Developer": name who may be asked, or "everyone"',
        'allow_calls for "Tuner Developer": "Tuner Developer" is not the name of exactly one other coworker',
    ])
})

test('a card kept before the new line existed is still read', async () => {
    const { desktopTeamChangesSchema } = await import('@rerun/contracts')
    const old = { id: 'ftc_12345678', summary: 's', state: 'shown', createdAt: 'now', changes: [{ key: 'change-0', action: 'switch_on', agentId: 'a1', coworker: 'Dev', permission: null, connectionId: null, model: null, effort: null, label: 'Switch on Dev', caution: null, result: null }] }
    const parsed = desktopTeamChangesSchema.parse(old)
    expect(parsed.changes[0]).toMatchObject({ targetAgentIds: null, chief: false })
})

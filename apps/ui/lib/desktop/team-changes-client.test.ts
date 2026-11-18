import { expect, test, vi } from 'vitest'
import type { DesktopTeamChange, DesktopTeamChanges } from '@rerun/contracts'
import { applyTeamChanges, teamChangesClient, type TeamChangesPorts } from './team-changes-client'

const change = (key: string, action: DesktopTeamChange['action'], extra: Partial<DesktopTeamChange> = {}): DesktopTeamChange => ({
    key, action, agentId: 'a1', coworker: 'Dev', permission: null, connectionId: null, model: null, effort: null, targetAgentIds: null, chief: false, label: `${action} Dev`, caution: null, result: null, ...extra,
})
const card = (changes: DesktopTeamChange[]): DesktopTeamChanges => ({ id: 'ftc_12345678', summary: 's', state: 'shown', changes, createdAt: 'now' })
function fake() {
    const calls: string[] = []
    const ports: TeamChangesPorts = {
        read: async () => ({ changes: null }),
        settle: async (id, state, results) => { calls.push(`settle ${state} ${JSON.stringify(results.map(result => [result.key, result.ok]))}`); return { changes: null } },
        setEnabled: async (id, enabled) => { calls.push(`enabled ${id} ${enabled}`) },
        setPermission: async (id, permission, enabled) => { calls.push(`permission ${id} ${permission} ${enabled}`) },
        changeSetup: async (id, action, rev) => { calls.push(`${id} ${action} ${rev}`) },
        replySetup: async (id, key) => { calls.push(`reply ${id} ${key}`) },
        startSetup: async id => { calls.push(`setup ${id}`) },
        allowCalls: async (id, targets) => { calls.push(`calls ${id ?? 'chief'} ${targets.join(',')}`) },
        setModel: async (id, connection, model) => { calls.push(`model ${id} ${connection} ${model}`) },
        setEffort: async (connection, model, effort) => { calls.push(`effort ${connection} ${model} ${effort}`) },
    }
    return { ports, calls }
}
test('only the ticked lines are applied, each through its own request, and every outcome is written down', async () => {
    const { ports, calls } = fake()
    ports.startSetup = async () => { throw new Error('Setup is already running.') }
    const all = card([
        change('change-0', 'switch_on'), change('change-1', 'allow', { permission: 'callAgent' }), change('change-2', 'give_github'),
        change('change-3', 'give_github', { agentId: 'a2' }), change('change-4', 'start_setup'), change('change-5', 'set_model', { connectionId: 'c', model: 'm' }),
        change('change-6', 'set_effort', { agentId: null, connectionId: 'c', model: 'm', effort: 'high' }), change('change-7', 'switch_off', { agentId: 'a9' }),
    ])
    await applyTeamChanges(ports, all, new Set(all.changes.map(item => item.key).filter(key => key !== 'change-7')))
    expect(calls).toEqual([
        'enabled a1 true', 'permission a1 callAgent true',
        // GitHub is the coworker's own repository permission, and nothing from the Vault.
        'permission a1 repositoryWorkspace true', 'permission a2 repositoryWorkspace true', 'model a1 c m', 'effort c m high',
        'settle applied [["change-0",true],["change-1",true],["change-2",true],["change-3",true],["change-4",false],["change-5",true],["change-6",true]]',
    ])
})

test('a line whose coworker is gone fails by itself and says so', async () => {
    const { ports, calls } = fake()
    await applyTeamChanges(ports, card([change('change-0', 'switch_on', { agentId: null }), change('change-1', 'switch_on')]), new Set(['change-0', 'change-1']))
    expect(calls).toEqual(['enabled a1 true', 'settle applied [["change-0",false],["change-1",true]]'])
})

test('who may be asked is added through its own request, for a coworker and for the Chief of Staff', async () => {
    const { ports, calls } = fake()
    await applyTeamChanges(ports, card([
        change('change-0', 'allow_calls', { targetAgentIds: ['b', 'c'] }),
        change('change-1', 'allow_calls', { agentId: null, coworker: null, chief: true, targetAgentIds: ['a1'] }),
        change('change-2', 'allow_calls', { agentId: null, coworker: null, targetAgentIds: ['b'] }),
    ]), new Set(['change-0', 'change-1', 'change-2']))
    expect(calls).toEqual(['calls a1 b,c', 'calls chief a1', 'settle applied [["change-0",true],["change-1",true],["change-2",false]]'])
})

test('approval sends only selected saved setup lines and keeps other coworkers untouched', async () => {
    const { ports, calls } = fake()
    await applyTeamChanges(ports, card([change('change-0', 'reply_setup'), change('change-1', 'reply_setup', { agentId: 'qa' })]), new Set(['change-1']))
    expect(calls).toEqual(['reply ftc_12345678 change-1', 'settle applied [["change-1",true]]'])
})

test('skip and resume use only the setup revision reviewed on the card', async () => {
    const { ports, calls } = fake()
    await applyTeamChanges(ports, card([
        change('change-0', 'skip_setup', { setupRevision: 'reviewed-1' }),
        change('change-1', 'continue_setup', { setupRevision: 'reviewed-2', setupResumeAction: 'continue' }), change('change-2', 'skip_setup'),
        change('change-3', 'continue_setup', { setupRevision: 'reviewed-3', setupResumeAction: 'start' }),
    ]), new Set(['change-0', 'change-1', 'change-2','change-3']))
    expect(calls).toEqual(['a1 skip reviewed-1', 'a1 continue reviewed-2', 'a1 start reviewed-3', 'settle applied [["change-0",true],["change-1",true],["change-2",false],["change-3",true]]'])
})

test('a stale start proposal cannot restart a setup skipped after review', async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json({ canStart: true, pending: false, skipped: true, completedAt: null, sessionId: null, revision: 'current' }))
    vi.stubGlobal('fetch', fetch)
    try {
        await expect(teamChangesClient({ workspaceId: '1', chatId: 'fmc_fixturechief0001' }).startSetup('qa')).rejects.toThrow('skipped')
        expect(fetch).toHaveBeenCalledTimes(1)
        expect(fetch.mock.calls[0]![0]).toBe('/api/desktop/coworkers/qa/setup?observe=1')
    } finally { vi.unstubAllGlobals() }
})

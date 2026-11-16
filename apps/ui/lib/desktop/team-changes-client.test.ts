import { expect, test } from 'vitest'
import type { DesktopTeamChange, DesktopTeamChanges } from '@rerun/contracts'
import { applyTeamChanges, type TeamChangesPorts, type TeamGithubTarget } from './team-changes-client'

const change = (key: string, action: DesktopTeamChange['action'], extra: Partial<DesktopTeamChange> = {}): DesktopTeamChange => ({
    key, action, agentId: 'a1', coworker: 'Dev', permission: null, connectionId: null, model: null, effort: null, label: `${action} Dev`, caution: null, result: null, ...extra,
})
const card = (changes: DesktopTeamChange[]): DesktopTeamChanges => ({ id: 'ftc_12345678', summary: 's', state: 'shown', changes, createdAt: 'now' })
function fake() {
    const calls: string[] = []
    const ports: TeamChangesPorts = {
        read: async () => ({ changes: null, github: null }),
        settle: async (id, state, results) => { calls.push(`settle ${state} ${JSON.stringify(results.map(result => [result.key, result.ok]))}`); return { changes: null, github: null } },
        setEnabled: async (id, enabled) => { calls.push(`enabled ${id} ${enabled}`) },
        setPermission: async (id, permission, enabled) => { calls.push(`permission ${id} ${permission} ${enabled}`) },
        shareEntry: async (entry, agentIds) => { calls.push(`share ${entry.id} ${agentIds.join(',')}`) },
        attachAccount: async (account, id) => { calls.push(`attach ${account} ${id}`) },
        startSetup: async id => { calls.push(`setup ${id}`) },
        setModel: async (id, connection, model) => { calls.push(`model ${id} ${connection} ${model}`) },
        setEffort: async (connection, model, effort) => { calls.push(`effort ${connection} ${model} ${effort}`) },
    }
    return { ports, calls }
}
const connect: TeamGithubTarget = { via: 'composio-connect', entry: { id: 'e1', revision: 'r1', sharedWithAll: false, agentIds: ['old'] }, alsoGives: [] }

test('only the ticked lines are applied, each through its own request, and every outcome is written down', async () => {
    const { ports, calls } = fake()
    ports.startSetup = async () => { throw new Error('Setup is already running.') }
    const all = card([
        change('change-0', 'switch_on'), change('change-1', 'allow', { permission: 'callAgent' }), change('change-2', 'give_github'),
        change('change-3', 'give_github', { agentId: 'a2' }), change('change-4', 'start_setup'), change('change-5', 'set_model', { connectionId: 'c', model: 'm' }),
        change('change-6', 'set_effort', { agentId: null, connectionId: 'c', model: 'm', effort: 'high' }), change('change-7', 'switch_off', { agentId: 'a9' }),
    ])
    await applyTeamChanges(ports, all, connect, new Set(all.changes.map(item => item.key).filter(key => key !== 'change-7')))
    expect(calls).toEqual([
        // One write gives the entry to both coworkers and keeps who had it.
        'share e1 old,a1,a2',
        'enabled a1 true', 'permission a1 callAgent true', 'permission a1 mcp true', 'permission a2 mcp true', 'model a1 c m', 'effort c m high',
        'settle applied [["change-0",true],["change-1",true],["change-2",true],["change-3",true],["change-4",false],["change-5",true],["change-6",true]]',
    ])
})

test('GitHub through a project key attaches the account alone, and a failed share fails only the GitHub lines', async () => {
    const project = fake()
    await applyTeamChanges(project.ports, card([change('change-0', 'give_github'), change('change-1', 'give_github', { agentId: 'has' })]), { via: 'composio-project', account: { id: 'gh', agentIds: ['has'] }, alsoGives: [] }, new Set(['change-0', 'change-1']))
    expect(project.calls).toEqual(['attach gh a1', 'settle applied [["change-0",true],["change-1",true]]'])

    const failing = fake()
    failing.ports.shareEntry = async () => { throw new Error('This Vault entry changed.') }
    await applyTeamChanges(failing.ports, card([change('change-0', 'give_github'), change('change-1', 'switch_on')]), connect, new Set(['change-0', 'change-1']))
    expect(failing.calls).toEqual(['enabled a1 true', 'settle applied [["change-0",false],["change-1",true]]'])
    // Without a GitHub sign-in the line fails and says so.
    const none = fake()
    await applyTeamChanges(none.ports, card([change('change-0', 'give_github')]), null, new Set(['change-0']))
    expect(none.calls).toEqual(['settle applied [["change-0",false]]'])
})

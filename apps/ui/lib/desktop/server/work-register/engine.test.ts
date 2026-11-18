import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createClient, type Client } from '@libsql/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

vi.mock('server-only', () => ({}))
vi.mock('../store', () => ({ listDesktopAgents: async () => [{ id: 'a1', name: 'Tuner Developer', workspaceId: 1 }, { id: 'a2', name: 'Server Developer', workspaceId: 1 }] }))
const { answerDesktopWorkRegisterCall, DESKTOP_WORK_REGISTER_OFF } = await import('./engine')
import type { DesktopWorkCallerPorts } from './engine'

let dir: string, db: Client
beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'rerun-work-engine-'))
    db = createClient({ url: `file:${join(dir, 'w.db')}` })
    await db.executeMultiple(`CREATE TABLE desktop_agents(id TEXT PRIMARY KEY, workspace_id INTEGER, engine_agent_id TEXT, name TEXT, enabled INTEGER);
        CREATE TABLE desktop_deletions(agent_id TEXT PRIMARY KEY);
        INSERT INTO desktop_agents VALUES ('a1', 1, 'eng-tuner', 'Tuner Developer', 1), ('a2', 1, 'eng-server', 'Server Developer', 1);`)
})
afterEach(async () => { db.close(); await rm(dir, { recursive: true, force: true }) })

const grants = (workRegister?: boolean) => ({ desktopToolGrants: workRegister === undefined ? {} : { workRegister } })
function ports(over: Partial<{ grant: boolean | undefined; kind: string; running: boolean; foremanTurn: boolean; enabled: boolean }> = {}): DesktopWorkCallerPorts {
    const value = { grant: true, kind: 'agent', running: true, foremanTurn: true, enabled: true, ...over }
    return {
        config: async id => ({ enabled: value.enabled, kind: id === 'foreman' ? 'foreman' : value.kind, tools: grants(value.grant) as never }),
        running: async () => value.running,
        foremanTurn: async () => value.foremanTurn,
    }
}
const call = (agentId: string, op: 'list' | 'upsert' | 'note', input: Record<string, unknown>) => ({ op, caller: { agentId, sessionId: 's1', runId: 'r1' }, input }) as never
const signal = new AbortController().signal

test('with the permission off the register refuses every tool, for a coworker and for the Chief of Staff', async () => {
    for (const grant of [undefined, false]) {
        for (const agentId of ['eng-tuner', 'foreman']) {
            for (const [op, input] of [['list', {}], ['upsert', { project: 'p', objective: 'o' }], ['note', { id: 'w_1', update: 'x' }]] as const) {
                await expect(answerDesktopWorkRegisterCall(db, '1', call(agentId, op, input), ports({ grant }), signal)).rejects.toMatchObject({ status: 403, message: DESKTOP_WORK_REGISTER_OFF })
            }
        }
    }
    const tables = (await db.execute("SELECT name FROM sqlite_master WHERE name='desktop_work_items'")).rows
    expect(tables).toHaveLength(0)
})

test('a run that is over, a switched-off coworker, a copy, or a Chief of Staff run the app did not start is refused', async () => {
    await expect(answerDesktopWorkRegisterCall(db, '1', call('eng-tuner', 'list', {}), ports({ running: false }), signal)).rejects.toMatchObject({ status: 409 })
    await expect(answerDesktopWorkRegisterCall(db, '1', call('eng-tuner', 'list', {}), ports({ enabled: false }), signal)).rejects.toMatchObject({ status: 403 })
    await expect(answerDesktopWorkRegisterCall(db, '1', call('foreman', 'list', {}), ports({ foremanTurn: false }), signal)).rejects.toMatchObject({ status: 409 })
    // An agent that claims to be the Chief of Staff under another id is not one.
    await expect(answerDesktopWorkRegisterCall(db, '1', call('eng-tuner', 'list', {}), ports({ kind: 'foreman' }), signal)).rejects.toMatchObject({ status: 403 })
    // An engine agent that is not one of the workspace's coworkers.
    await expect(answerDesktopWorkRegisterCall(db, '1', call('eng-stranger', 'list', {}), ports(), signal)).rejects.toMatchObject({ status: 403 })
    await db.execute("INSERT INTO desktop_deletions VALUES ('a1')")
    await expect(answerDesktopWorkRegisterCall(db, '1', call('eng-tuner', 'list', {}), ports(), signal)).rejects.toMatchObject({ status: 403 })
})

test('coworkers and the Chief of Staff work on one register, each within its own rights', async () => {
    const assigned = await answerDesktopWorkRegisterCall(db, '1', call('foreman', 'upsert', { project: 'tuner', owner: 'Tuner Developer', objective: 'Probe the tuner', nextAction: 'Run the probe' }), ports(), signal) as { item: { id: string; revision: number; owner: string } }
    expect(assigned.item).toMatchObject({ owner: 'Tuner Developer', revision: 1 })
    // The owner records progress; another coworker cannot.
    expect(await answerDesktopWorkRegisterCall(db, '1', call('eng-tuner', 'upsert', { id: assigned.item.id, expectedRevision: 1, status: 'working', update: 'Probing' }), ports(), signal)).toMatchObject({ item: { status: 'working', revision: 2 } })
    await expect(answerDesktopWorkRegisterCall(db, '1', call('eng-server', 'note', { id: assigned.item.id, update: 'Mine now' }), ports(), signal)).rejects.toMatchObject({ status: 403 })
    // The same objective again is the same item.
    expect(await answerDesktopWorkRegisterCall(db, '1', call('foreman', 'upsert', { project: 'Tuner', owner: 'tuner developer', objective: 'probe the tuner' }), ports(), signal)).toMatchObject({ duplicate: true, created: false, item: { id: assigned.item.id } })
    const listed = await answerDesktopWorkRegisterCall(db, '1', call('eng-server', 'list', { project: 'tuner' }), ports(), signal) as { items: { id: string; latestUpdate: string }[] }
    expect(listed.items.map(item => item.id)).toEqual([assigned.item.id])
    expect(listed.items[0]!.latestUpdate).toContain('Probing (Tuner Developer,')
})

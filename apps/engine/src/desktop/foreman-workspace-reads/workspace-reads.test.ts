import { afterEach, describe, expect, it, vi } from 'vitest'
import { FOREMAN_WORKSPACE_READ_MESSAGES as M, FOREMAN_WORKSPACE_READ_ROW_LIMIT } from '@rerun/contracts'
import type { RunContext } from '../../runtime/context.js'
import { isDesktopForemanTool, registerDesktopForemanTools } from '../foreman/tool-identity.js'
import { bindForemanWorkspaceReads, readForemanWorkspaceReads, unbindForemanWorkspaceReads } from './binding.js'
import { createDesktopForemanWorkspacePorts } from './catalog.js'
import { createForemanWorkspaceReadTools } from './tools.js'
import type { ForemanWorkspaceReadContext, ForemanWorkspaceReadPorts } from './ports.js'
import type { DesktopTeamMember, DesktopTeamReadAck } from '../team-reads/ports.js'

const state = vi.hoisted(() => ({ running: true }))
vi.mock('../../agents/registry.js', () => ({ getAgent: async () => ({ id: 'foreman', config: { kind: 'foreman', enabled: true } }) }))
vi.mock('../../db/repos/sessions.js', () => ({ getSession: async () => ({ id: 'session', agentId: 'foreman', source: 'dashboard', status: 'open', originAgentId: null, originSessionId: null }) }))
vi.mock('../../db/repos/runs.js', () => ({ getRun: async () => ({ id: 'run', agentId: 'foreman', sessionId: 'session', status: state.running ? 'running' : 'cancelled' }) }))

import { bindDesktopForeman, desktopForemanTools } from '../foreman/binding.js'

const binding = { workspaceId: '1', chatId: 'fmc_chat-0001', runId: 'run-1', model: { connectionId: 'conn-1', model: 'model-a' } }
const ready = <T>(value: T): DesktopTeamReadAck<T> => ({ acknowledgement: 'ready', value })

function member(patch: Partial<DesktopTeamMember> = {}): DesktopTeamMember {
    return { publicId: 'agent-1', engineAgentId: 'engine-1', name: 'Ada', handle: 'ada', spaceId: 'box-1', enabled: true, configured: true, deleting: false, ...patch }
}

function snapshot(patch: Record<string, unknown> = {}) {
    return {
        kind: 'ready' as const,
        workspaceId: '1',
        catalogWorkspaceId: '1',
        revision: 4,
        boxes: [{ id: 'box-1', name: 'Studio' }],
        roster: [{ id: 'agent-1', workspaceId: '1', name: 'Ada', handle: null, description: 'Writes', spaceId: 'box-1', enabled: true, deleting: false }],
        foreignIds: [] as string[],
        ...patch,
    }
}

function harness(options: {
    grant?: () => Promise<boolean>
    snap?: () => Promise<unknown>
    members?: DesktopTeamMember[]
    lookup?: (id: string) => { kind: 'member'; member: DesktopTeamMember } | { kind: 'other-workspace' } | { kind: 'missing' } | { kind: 'uncertain' }
    schedules?: () => Promise<DesktopTeamReadAck<unknown[]>>
    triggers?: () => Promise<DesktopTeamReadAck<unknown[]>>
} = {}) {
    const grant = vi.fn(options.grant ?? (async () => true))
    const snap = vi.fn(options.snap ?? (async () => snapshot()))
    const people = options.members ?? [member()]
    const schedules = vi.fn(options.schedules ?? (async () => ready([{ slug: 'daily', name: 'Daily', description: 'Morning', body: 'Write the note', cron: '0 9 * * *', runAt: null, timezone: 'UTC', enabled: true, lastRunAt: null }])))
    const triggers = vi.fn(options.triggers ?? (async () => ready([{ slug: 'hook', name: 'Hook', description: '', body: 'Run', methods: ['POST'], enabled: true, fireCount: 2, lastFiredAt: null, token: 'sekret-token', url: 'https://hooks.example/t/sekret-token' }])))
    const directory = {
        members: vi.fn(async () => ready(people)),
        lookup: vi.fn(async (_workspace: string, id: string) => options.lookup?.(id) ?? (id === 'agent-1' ? { kind: 'member' as const, member: people[0]! } : { kind: 'missing' as const })),
    }
    const ports = createDesktopForemanWorkspacePorts({ grant, snapshot: snap as ForemanWorkspaceReadPorts['snapshot'], directory, schedules: schedules as ForemanWorkspaceReadPorts['schedules'], triggers: triggers as ForemanWorkspaceReadPorts['triggers'] })
    const factory = createForemanWorkspaceReadTools(ports)
    const ctx: ForemanWorkspaceReadContext = { binding, assertCurrent: async () => {}, signal: new AbortController().signal }
    const call = async (name: string, input: unknown = {}, context = ctx) => {
        const toolset = factory.tools(context)
        const fn = toolset[name] as { execute: (value: never, options: { toolCallId: string }) => Promise<unknown> }
        return fn.execute(input as never, { toolCallId: 'call-1' })
    }
    return { grant, snap, directory, schedules, triggers, factory, call, ctx, ports }
}

afterEach(() => { unbindForemanWorkspaceReads(); state.running = true })

describe('foreman workspace reads', () => {
    it('refuses when the grant is off and does not read the catalog', async () => {
        const { call, snap, schedules, triggers } = harness({ grant: async () => false })
        await expect(call('list_agents')).rejects.toThrow(M.refused)
        await expect(call('list_spaces')).rejects.toThrow(M.refused)
        await expect(call('list_schedules', { agentId: 'agent-1' })).rejects.toThrow(M.refused)
        expect(snap).not.toHaveBeenCalled()
        expect(schedules).not.toHaveBeenCalled()
        expect(triggers).not.toHaveBeenCalled()
    })

    it('refuses another workspace and does not return its routine text', async () => {
        const secret = 'other-workspace-routine-secret'
        const { call, schedules } = harness({
            snap: async () => snapshot({ foreignIds: ['foreign-agent'] }),
            lookup: id => id === 'foreign-agent' ? { kind: 'other-workspace' } : { kind: 'member', member: member() },
            schedules: async () => ready([{ slug: 'x', name: 'X', description: '', body: secret, cron: null, runAt: null, timezone: null, enabled: true, lastRunAt: null }]),
        })
        await expect(call('list_schedules', { agentId: 'foreign-agent' })).rejects.toThrow(M.otherWorkspace)
        const listed = await call('list_agents') as { agents: { id: string }[] }
        expect(listed.agents.map(agent => agent.id)).toEqual(['agent-1'])
        const whole = harness({ snap: async () => ({ kind: 'other-workspace' }) })
        await expect(whole.call('list_spaces')).rejects.toThrow(M.otherWorkspace)
        expect(schedules).not.toHaveBeenCalled()
        expect(JSON.stringify(listed)).not.toContain(secret)
    })

    it('refuses a coworker lookup that belongs to another workspace without reading routines', async () => {
        const { call, schedules, triggers } = harness({
            snap: async () => snapshot({ foreignIds: ['foreign-agent'] }),
            lookup: () => ({ kind: 'other-workspace' }),
        })
        await expect(call('list_triggers', { agentId: 'foreign-agent' })).rejects.toThrow(M.otherWorkspace)
        expect(schedules).not.toHaveBeenCalled()
        expect(triggers).not.toHaveBeenCalled()
    })

    it('refuses when the grant is revoked between registration and the call', async () => {
        let allowed = true
        const { call, factory, schedules } = harness({
            grant: async () => allowed,
            snap: async () => { allowed = false; return snapshot() },
        })
        registerDesktopForemanTools(factory.tools({ binding, assertCurrent: async () => {}, signal: new AbortController().signal }))
        await expect(call('list_agents')).rejects.toThrow(M.refused)
        expect(schedules).not.toHaveBeenCalled()
    })

    it('rebuilds the same answers and the same denials from the store after a cold reopen', async () => {
        const store = { allowed: false, revision: 7, description: 'Writes the brief' }
        const portsFor = () => harness({
            grant: async () => store.allowed,
            snap: async () => snapshot({ revision: store.revision, roster: [{ id: 'agent-1', workspaceId: '1', name: 'Ada', handle: null, description: store.description, spaceId: 'box-1', enabled: true, deleting: false }] }),
        })
        const denied = portsFor()
        await expect(denied.call('list_agents')).rejects.toThrow(M.refused)
        const deniedAgain = portsFor()
        await expect(deniedAgain.call('list_spaces')).rejects.toThrow(M.refused)
        store.allowed = true
        const opened = portsFor()
        const first = await opened.call('list_agents')
        const reopened = portsFor()
        const second = await reopened.call('list_agents')
        expect(second).toEqual(first)
        expect(JSON.stringify(second)).toContain('Writes the brief')
        expect(JSON.stringify(second)).not.toContain('engine-1')
        expect(opened.snap.mock.calls.length).toBeGreaterThan(0)
        expect(reopened.snap).not.toBe(opened.snap)
        store.allowed = false
        await expect(portsFor().call('list_agents')).rejects.toThrow(M.refused)
    })

    it('refuses a pinned revision that is not the catalog revision and does not return the roster', async () => {
        const { call } = harness()
        await expect(call('list_agents', { revision: 3 })).rejects.toThrow(M.stale)
        await expect(call('list_spaces', { revision: 3 })).rejects.toThrow(M.stale)
        const current = await call('list_spaces') as { revision: number; spaces: { name: string }[] }
        expect(current.revision).toBe(4)
        expect(current.spaces).toEqual([{ id: 'box-1', name: 'Studio', agentCount: 1 }])
    })

    it('lists roster and boxes with scrubbed fields and a row cap', async () => {
        const { call, directory } = harness({
            snap: async () => snapshot({
                workspaceId: '4',
                catalogWorkspaceId: '1',
                roster: [{ id: 'agent-1', workspaceId: '4', name: 'Ada', handle: null, description: 'notes /Users/ada/secrets.txt Bearer sekret-token', spaceId: 'box-1', enabled: true, deleting: false }],
            }),
        })
        const ctx = { binding: { ...binding, workspaceId: '4' }, assertCurrent: async () => {}, signal: new AbortController().signal }
        const agents = await call('list_agents', {}, ctx) as { agents: { description: string; handle: string | null; id: string }[] }
        expect(agents.agents[0]).toMatchObject({ id: 'agent-1', name: 'Ada', handle: 'ada', spaceId: 'box-1', enabled: true })
        expect(agents.agents[0]!.description).not.toContain('/Users/ada')
        expect(agents.agents[0]!.description).not.toContain('sekret-token')
        expect(JSON.stringify(agents)).not.toContain('engine-1')
        expect(directory.members).toHaveBeenCalledWith('1')
        await expect(call('list_agents', { spaceId: 'missing' }, ctx)).rejects.toThrow(M.notFound)
    })

    it('returns routine metadata without webhook secrets and refuses a deleting coworker', async () => {
        const live = harness()
        const triggers = await live.call('list_triggers', { agentId: 'agent-1' }) as { triggers: { body: string; slug: string }[] }
        expect(JSON.stringify(triggers)).not.toContain('sekret-token')
        expect(JSON.stringify(triggers)).not.toContain('hooks.example')
        expect(triggers.triggers[0]!.slug).toBe('hook')
        const schedules = await live.call('list_schedules', { agentId: 'agent-1' }) as { schedules: { slug: string; body: string }[]; agentId: string }
        expect(schedules.agentId).toBe('agent-1')
        expect(schedules.schedules[0]).toMatchObject({ slug: 'daily', body: 'Write the note', enabled: true })
        expect(JSON.stringify(schedules)).not.toContain('engine-1')
        const deleting = harness({ members: [member({ deleting: true })] })
        await expect(deleting.call('list_schedules', { agentId: 'agent-1' })).rejects.toThrow(M.notFound)
        expect(deleting.schedules).not.toHaveBeenCalled()
    })

    it('refuses when the roster and the directory disagree or the row cap is passed', async () => {
        const moved = harness({ members: [member({ spaceId: 'box-2' })] })
        await expect(moved.call('list_agents')).rejects.toThrow(M.stale)
        const rows = Array.from({ length: FOREMAN_WORKSPACE_READ_ROW_LIMIT + 1 }, (_, index) => member({ publicId: `agent-${index}`, engineAgentId: `engine-${index}`, name: index === 50 ? 'SECRET_ROW' : `Coworker ${index}` }))
        const crowded = harness({
            members: rows,
            snap: async () => snapshot({
                boxes: [{ id: 'box-1', name: 'Studio' }],
                roster: rows.map(row => ({ id: row.publicId, workspaceId: '1', name: row.name, handle: null, description: '', spaceId: 'box-1', enabled: true, deleting: false })),
            }),
        })
        await expect(crowded.call('list_agents')).rejects.toThrow(M.limit)
    })

    it('does not add file, skill, data, or team-read tools', () => {
        const { factory } = harness()
        const names = Object.keys(registerDesktopForemanTools(factory.tools({ binding, assertCurrent: async () => {}, signal: new AbortController().signal })))
        expect(names).toEqual(['list_spaces', 'list_agents', 'list_schedules', 'list_triggers'])
        for (const absent of ['agent_files_read', 'fs_read', 'skill_list', 'db_query', 'shared_db_schema', 'team_status', 'team_get_run']) expect(names).not.toContain(absent)
    })
})

const runtime = { launchNonce: '00000000-0000-4000-8000-000000000001', app: { origin: 'http://127.0.0.1:44000' }, engine: { apiKey: 'a'.repeat(64) } }
let stop: (() => void) | undefined

describe('foreman tool registry', () => {
    afterEach(() => { stop?.(); stop = undefined; unbindForemanWorkspaceReads(); vi.unstubAllEnvs() })

    it('keeps workspace reads off the belt until root binds them, then admits only the Foreman', async () => {
        vi.stubEnv('RERUN_DESKTOP_APP', '1')
        const live = { ...binding, runId: 'run' }
        const network = vi.fn(async () => Response.json({ binding: live, discovery: false })) as typeof fetch
        stop = bindDesktopForeman(runtime, network).close
        const context = () => ({ agent: { id: 'foreman', config: { kind: 'foreman', enabled: true, tools: { cards: false } }, resolved: { connection: { id: 'conn-1' }, model: 'model-a' } }, sessionId: 'session', runId: 'run', model: 'model-a', abortSignal: new AbortController().signal }) as unknown as RunContext
        const before = await desktopForemanTools(context())
        expect(Object.keys(before.tools)).not.toContain('list_spaces')
        const { ports } = harness()
        bindForemanWorkspaceReads(ports)
        expect(readForemanWorkspaceReads()).toBeTruthy()
        const after = await desktopForemanTools(context())
        expect(Object.keys(after.tools)).toEqual(expect.arrayContaining(['show_plan', 'open_panel', 'search_docs', 'ask_user', 'list_spaces', 'list_agents', 'list_schedules', 'list_triggers']))
        for (const absent of ['agent_files_read', 'team_status', 'skill_list', 'db_query', 'fs_read']) expect(Object.keys(after.tools)).not.toContain(absent)
        expect(isDesktopForemanTool(after.tools.list_spaces, 'list_spaces', 'foreman', 'foreman')).toBe(true)
        expect(isDesktopForemanTool(after.tools.list_agents, 'list_agents', 'other', 'foreman')).toBe(false)
        expect(isDesktopForemanTool(after.tools.list_schedules, 'list_schedules', 'foreman', 'coworker')).toBe(false)
        unbindForemanWorkspaceReads()
        bindForemanWorkspaceReads({ ...ports, grant: async () => false })
        const hidden = await desktopForemanTools(context())
        expect(Object.keys(hidden.tools)).not.toContain('list_spaces')
        bindForemanWorkspaceReads(ports)
        const restored = await desktopForemanTools(context())
        const listed = await restored.tools.list_spaces!.execute!({} as never, { toolCallId: 'call-9', messages: [] })
        expect(listed).toMatchObject({ revision: 4, spaces: [{ id: 'box-1', name: 'Studio', agentCount: 1 }] })
    })
})

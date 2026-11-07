import { afterEach, describe, expect, it, vi } from 'vitest'
import {
    DESKTOP_TEAM_READ_DESCRIPTIONS,
    DESKTOP_TEAM_READ_MESSAGES as M,
    DESKTOP_TEAM_READ_PERMISSION,
    DESKTOP_TEAM_READ_TOOL_NAMES,
    desktopTeamReadGrantOn,
} from '@rerun/contracts'
import { readDesktopTeamAdmit, readDesktopTeamActivity, readDesktopTeamRun, readDesktopTeamSchedules, readDesktopTeamTriggers } from './adapters.js'
import { bindDesktopTeamReads, readDesktopTeamReads, unbindDesktopTeamReads } from './binding.js'
import { readDesktopTeamReadGrant } from './grant.js'
import { desktopTeamActivityFrom, desktopTeamMemberStatus, desktopTeamRunLimit, desktopTeamScheduleView, desktopTeamToolCallView, desktopTeamTriggerView, desktopTeamTruncateField } from './project.js'
import { createDesktopTeamReadTools } from './tools.js'
import type { DesktopTeamActivity, DesktopTeamMember, DesktopTeamReadAck, DesktopTeamReadToolContext, DesktopTeamReads, DesktopTeamToolCallView } from './ports.js'

const ready = <T>(value: T): DesktopTeamReadAck<T> => ({ acknowledgement: 'ready', value })
const base: DesktopTeamReadToolContext = { agent: { id: 'eng-a' }, runId: 'run-a', sessionId: 'sess-a' }

function person(patch: Partial<DesktopTeamMember> = {}): DesktopTeamMember {
    return {
        publicId: 'pub-b', engineAgentId: 'eng-b', name: 'Blair', handle: 'blair', spaceId: 'space-1',
        enabled: true, configured: true, deleting: false, ...patch,
    }
}

function activity(patch: Partial<DesktopTeamActivity> = {}): DesktopTeamActivity {
    return { running: [], waitingOn: [], lastFinished: null, ...patch }
}

function runRow(patch: Record<string, unknown> = {}) {
    return {
        runId: 'run-b', status: 'done', sessionId: 'sess-b', provider: 'openai', model: 'm', trigger: 'schedule:daily',
        steps: 1, inputTokens: 1, outputTokens: 2, totalTokens: 3, costUsd: 0.001, startedAt: '2026-01-01T00:00:00.000Z',
        finishedAt: '2026-01-01T00:01:00.000Z', error: null, output: 'finished text', ...patch,
    }
}

function harness(options: { grant?: (id: string) => Promise<boolean>; admit?: 'ok' | 'uncertain' | 'refused'; members?: DesktopTeamMember[]; lookup?: (id: string) => { kind: 'member'; member: DesktopTeamMember } | { kind: 'other-workspace' } | { kind: 'missing' } | { kind: 'uncertain' } } = {}) {
    const grant = vi.fn(options.grant ?? (async (id: string) => id === 'eng-a'))
    const admit = vi.fn(async () => options.admit ?? 'ok')
    const schedules = vi.fn(async () => ready([{ slug: 'daily', name: 'Daily', description: '', body: 'Do it', cron: '0 9 * * *', runAt: null, timezone: 'UTC', enabled: true, lastRunAt: null }]))
    const triggers = vi.fn(async () => ready([desktopTeamTriggerView({ slug: 'hook', name: 'Hook', description: '', body: 'Run', methods: ['POST'], enabled: true, fireCount: 2, lastFiredAt: null, token: 'sekret-token', url: 'https://hooks.example/t/sekret-token' })]))
    const runs = vi.fn(async (_id: string, limit: number) => ready([runRow({ steps: limit })]))
    const run = vi.fn(async () => ready(runRow()))
    const toolCalls = vi.fn(async (): Promise<DesktopTeamReadAck<DesktopTeamToolCallView[]>> => ready([{ step: 1, tool: 'web_fetch', input: 'x'.repeat(2001), result: 'Bearer sekret-token', isError: false, durationMs: 4 }]))
    const readActivity = vi.fn(async () => ready(activity({ running: [{ runId: 'live', sessionId: 'sess-b', trigger: 'chat', startedAt: 't', steps: 3 }], lastFinished: { runId: 'old', status: 'error', finishedAt: 'e', error: 'boom' } })))
    const startRun = vi.fn()
    const reads = { schedules, triggers, runs, run, toolCalls, activity: readActivity, startRun } as DesktopTeamReads & { startRun: ReturnType<typeof vi.fn> }
    const directory = {
        caller: vi.fn(async (id: string) => id === 'eng-a' ? { workspaceId: '1', publicId: 'pub-a', engineAgentId: 'eng-a' } : null),
        members: vi.fn(async (workspaceId: string) => ready(workspaceId === '1' ? options.members ?? [person()] : [])),
        lookup: vi.fn(async (workspaceId: string, id: string) => {
            if (workspaceId !== '1') return { kind: 'other-workspace' as const }
            if (options.lookup) return options.lookup(id)
            if (id === 'outsider') return { kind: 'other-workspace' as const }
            if (id === 'pub-b' || id === 'eng-b') return { kind: 'member' as const, member: person() }
            return { kind: 'missing' as const }
        }),
    }
    const factory = createDesktopTeamReadTools({ grant, admit, directory, reads })
    const call = async (name: string, input: unknown, ctx: DesktopTeamReadToolContext = base) => {
        const toolset = factory.tools(ctx)
        const fn = toolset[name] as { execute: (value: never, options: { toolCallId: string }) => Promise<unknown> }
        return fn.execute(input as never, { toolCallId: 'call-1' })
    }
    return { grant, admit, directory, schedules, triggers, runs, run, toolCalls, activity: readActivity, startRun, call, factory }
}

afterEach(() => unbindDesktopTeamReads())

describe('desktop team read grant', () => {
    it('accepts only an exact teamRead flag', () => {
        expect(desktopTeamReadGrantOn({ tools: { team: true } })).toBe(false)
        expect(desktopTeamReadGrantOn({ tools: { desktopToolGrants: { callAgent: true, scheduleManage: true, trigger: true } } })).toBe(false)
        expect(desktopTeamReadGrantOn({ tools: { desktopToolGrants: { teamRead: 'true' } } })).toBe(false)
        expect(desktopTeamReadGrantOn({ tools: { desktopToolGrants: { teamRead: false } } })).toBe(false)
        expect(desktopTeamReadGrantOn({ tools: { mcp: 'mcp:read', desktopToolGrants: { teamRead: true } } })).toBe(true)
    })

    it('does not read a symlinked or hard-linked config', async () => {
        const readFile = vi.fn(async () => '{"tools":{"desktopToolGrants":{"teamRead":true}}}')
        expect(await readDesktopTeamReadGrant('eng-a', { lstat: async () => ({ isFile: true, isSymbolicLink: true, nlink: 1, size: 10 }), readFile })).toBe(false)
        expect(await readDesktopTeamReadGrant('eng-a', { lstat: async () => ({ isFile: true, isSymbolicLink: false, nlink: 2, size: 10 }), readFile })).toBe(false)
        expect(readFile).not.toHaveBeenCalled()
        expect(await readDesktopTeamReadGrant('../eng-a', { lstat: async () => null, readFile })).toBe(false)
    })

    it('reads the raw flag once', async () => {
        const readFile = vi.fn(async () => JSON.stringify({ tools: { team: true, desktopToolGrants: { teamRead: true, callAgent: true } } }))
        expect(await readDesktopTeamReadGrant('eng-a', { lstat: async () => ({ isFile: true, isSymbolicLink: false, nlink: 1, size: 80 }), readFile })).toBe(true)
        expect(readFile).toHaveBeenCalledTimes(1)
    })
})

describe('desktop team read projection', () => {
    it('keeps the hosted status order', () => {
        const idle = { switchedOff: false, configured: true, reachable: true, runningCount: 0, waitingCount: 0, lastFinishedStatus: null }
        expect(desktopTeamMemberStatus({ ...idle, switchedOff: true, configured: false, reachable: false })).toBe('switched_off')
        expect(desktopTeamMemberStatus({ ...idle, configured: false, reachable: false })).toBe('unconfigured')
        expect(desktopTeamMemberStatus({ ...idle, reachable: false, runningCount: 2 })).toBe('offline')
        expect(desktopTeamMemberStatus({ ...idle, runningCount: 1, waitingCount: 1, lastFinishedStatus: 'error' })).toBe('working')
        expect(desktopTeamMemberStatus({ ...idle, waitingCount: 1, lastFinishedStatus: 'error' })).toBe('waiting_human')
        expect(desktopTeamMemberStatus({ ...idle, lastFinishedStatus: 'error' })).toBe('error')
        expect(desktopTeamMemberStatus(idle)).toBe('idle')
    })

    it('drops trigger secrets and clamps run limits', () => {
        const trigger = desktopTeamTriggerView({ slug: 'hook', name: 'Hook sekret-token', description: 'Visit https://hooks.example/t', body: 'token sekret-token url https://hooks.example/t', methods: ['POST'], enabled: true, fireCount: 1, lastFiredAt: null, token: 'sekret-token', url: 'https://hooks.example/t' })
        expect(JSON.stringify(trigger)).not.toContain('sekret-token')
        expect(JSON.stringify(trigger)).not.toContain('https://hooks.example/t')
        expect(trigger).not.toHaveProperty('token')
        expect(trigger).not.toHaveProperty('url')
        const schedule = desktopTeamScheduleView({ slug: 'daily', name: 'Daily', enabled: true, connectionId: 'conn-secret', provider: 'openai', model: 'm' } as never)
        expect(schedule).not.toHaveProperty('connectionId')
        expect(JSON.stringify(schedule)).not.toContain('conn-secret')
        expect(desktopTeamRunLimit(undefined)).toBe(20)
        expect(desktopTeamRunLimit(0)).toBe(1)
        expect(desktopTeamRunLimit(999)).toBe(200)
        expect(desktopTeamTruncateField('x'.repeat(2000))).toBe('x'.repeat(2000))
        expect(desktopTeamTruncateField('x'.repeat(2001))).toBe(`${'x'.repeat(2000)}… [truncated] 1 more chars elided to save context`)
    })

    it('counts only conversations waiting on a person', () => {
        const facts = desktopTeamActivityFrom(
            [{ id: 'r1', sessionId: 's', triggerSource: 'schedule', triggerSlug: 'daily', stepCount: 2, startedAt: 't' }],
            [{ id: 'r1', status: 'running', finishedAt: null, error: null }, { id: 'r0', status: 'done', finishedAt: 'e', error: null }],
            [{ id: 'open', status: 'open' }, { id: 'wait', status: 'waiting_human' }],
        )
        expect(facts.running).toEqual([{ runId: 'r1', sessionId: 's', trigger: 'schedule:daily', startedAt: 't', steps: 2 }])
        expect(facts.waitingOn).toEqual([{ sessionId: 'wait', reason: 'waiting_human' }])
        expect(facts.lastFinished).toMatchObject({ runId: 'r0', status: 'done' })
    })
})

describe('desktop team read tools', () => {
    it('exposes the five hosted names and refuses until bound', () => {
        expect(readDesktopTeamReads()).toBeUndefined()
        const box = harness()
        expect(Object.keys(box.factory.tools(base))).toEqual([...DESKTOP_TEAM_READ_TOOL_NAMES])
        expect(DESKTOP_TEAM_READ_DESCRIPTIONS.team_get_run).toContain('cut at 2,000 characters')
        expect(DESKTOP_TEAM_READ_PERMISSION.label).toBe('See other coworkers')
        expect(() => bindDesktopTeamReads({} as never)).toThrow('Desktop team read authority is required')
    })

    it('stays off without the dedicated grant and does not read', async () => {
        let flag = true
        const box = harness({ grant: async () => flag })
        flag = false
        await expect(box.call('team_list_schedules', { agentId: 'pub-b' })).rejects.toThrow(M.switchedOff)
        expect(box.schedules).not.toHaveBeenCalled()
        expect(box.startRun).not.toHaveBeenCalled()
        const borrowed = harness({ grant: async () => false })
        await expect(borrowed.call('team_status', {})).rejects.toThrow(M.switchedOff)
        expect(borrowed.directory.members).not.toHaveBeenCalled()
    })

    it('refuses another principal, another workspace, and a bad id without listing the team', async () => {
        const other = harness({ grant: async () => true })
        await expect(other.call('team_status', {}, { agent: { id: 'eng-c' }, runId: 'run-c', sessionId: 'sess-c' })).rejects.toThrow(M.workspaceUnbound)
        expect(other.directory.members).not.toHaveBeenCalled()
        const box = harness()
        await expect(box.call('team_list_triggers', { agentId: 'outsider' })).rejects.toThrow(M.otherWorkspace)
        expect(box.triggers).not.toHaveBeenCalled()
        const malformed = harness()
        await expect(malformed.call('team_status', { agentId: '../other' })).rejects.toThrow(M.malformed)
        expect(malformed.directory.members).not.toHaveBeenCalled()
        expect(malformed.grant).not.toHaveBeenCalled()
        await expect(malformed.call('team_list_schedules', {})).rejects.toThrow(M.malformed)
        expect(malformed.schedules).not.toHaveBeenCalled()
    })

    it('does not treat a lost acknowledgement as a team snapshot', async () => {
        const box = harness()
        box.schedules.mockResolvedValueOnce({ acknowledgement: 'uncertain' })
        await expect(box.call('team_list_schedules', { agentId: 'pub-b' })).rejects.toThrow(M.unavailable)
        expect(box.schedules).toHaveBeenCalledTimes(1)
        box.activity.mockRejectedValueOnce(new Error('sqlite closed'))
        await expect(box.call('team_status', {})).rejects.toThrow(M.unavailable)
        expect(box.activity).toHaveBeenCalledTimes(1)
        const stopped = harness()
        await expect(stopped.call('team_status', {}, { ...base, abortSignal: AbortSignal.abort() })).rejects.toThrow(M.runClosed)
        expect(stopped.grant).not.toHaveBeenCalled()
    })

    it('requires the current run and reads only the admitted workspace', async () => {
        const refused = harness({ admit: 'refused' })
        await expect(refused.call('team_list_runs', { agentId: 'pub-b' })).rejects.toThrow(M.runClosed)
        expect(refused.runs).not.toHaveBeenCalled()
        const lost = harness({ admit: 'uncertain' })
        await expect(lost.call('team_get_run', { agentId: 'pub-b', runId: 'run-b' })).rejects.toThrow(M.unavailable)
        expect(lost.run).not.toHaveBeenCalled()
        expect(lost.admit).toHaveBeenCalledTimes(1)
        const box = harness()
        const status = await box.call('team_status', {}) as { agents: Array<{ id: string; status: string; handle: string | null }> }
        expect(status.agents.map(agent => agent.id)).toEqual(['pub-b'])
        expect(status.agents[0]?.status).toBe('working')
        expect(box.directory.members).toHaveBeenCalledWith('1')
        expect(box.activity).toHaveBeenCalledWith('eng-b')
        const runs = await box.call('team_list_runs', { agentId: 'pub-b' }) as { runs: unknown[] }
        expect(box.runs).toHaveBeenCalledWith('eng-b', 20)
        expect(runs.runs).toHaveLength(1)
        await box.call('team_list_runs', { agentId: 'pub-b', limit: 999 })
        expect(box.runs).toHaveBeenLastCalledWith('eng-b', 200)
    })

    it('strips trigger secrets and does not execute a saved run', async () => {
        const box = harness()
        const triggers = await box.call('team_list_triggers', { agentId: 'pub-b' })
        expect(JSON.stringify(triggers)).not.toContain('sekret-token')
        expect(JSON.stringify(triggers)).not.toContain('https://')
        const quiet = await box.call('team_get_run', { agentId: 'pub-b', runId: 'run-b', includeToolCalls: false }) as { status: string; toolCalls?: unknown }
        expect(quiet.status).toBe('done')
        expect(quiet.toolCalls).toBeUndefined()
        expect(box.toolCalls).not.toHaveBeenCalled()
        expect(box.startRun).not.toHaveBeenCalled()
        const noisy = await box.call('team_get_run', { agentId: 'pub-b', runId: 'run-b', includeToolCalls: true }) as { toolCalls: Array<{ input: string; result: string }> }
        expect(noisy.toolCalls[0]?.input).toContain('… [truncated] 1 more chars')
        expect(noisy.toolCalls[0]?.result).toBe('Bearer [omitted]')
        expect(box.toolCalls).toHaveBeenCalledTimes(1)
        box.run.mockResolvedValueOnce(ready(null))
        await expect(box.call('team_get_run', { agentId: 'pub-b', runId: 'missing' })).rejects.toThrow(M.runNotFound)
    })

    it('does not invent idle for an unconfigured or unreachable coworker', async () => {
        const dark = harness({ members: [person({ configured: false, engineAgentId: '', reachable: false }), person({ publicId: 'pub-c', engineAgentId: 'eng-c', reachable: false })] })
        const status = await dark.call('team_status', {}) as { agents: Array<{ id: string; status: string }> }
        expect(status.agents.map(agent => agent.status)).toEqual(['unconfigured', 'offline'])
        expect(dark.activity).not.toHaveBeenCalled()
        const off = harness({ members: [person({ enabled: false })] })
        const switched = await off.call('team_status', {}) as { agents: Array<{ status: string; running: unknown[] }> }
        expect(switched.agents[0]?.status).toBe('switched_off')
        expect(switched.agents[0]?.running).toHaveLength(1)
    })

    it('omits nested credentials from persisted tool-call JSON without damaging safe fields', async () => {
        const box = harness()
        box.toolCalls.mockResolvedValueOnce(ready([desktopTeamToolCallView({
            stepNumber: 1, toolName: 'example', isError: false, durationMs: 4,
            inputJson: JSON.stringify({ command: 'read', args: [{ token: 'fixture-token', label: 'safe' }], password: 'fixture-password' }),
            resultJson: JSON.stringify({ apiKey: 'fixture-key', text: 'Bearer fixture-bearer', query: 'lookup?token=fixture-query' }),
        })]))
        const result = await box.call('team_get_run', { agentId: 'pub-b', runId: 'run-b', includeToolCalls: true }) as { toolCalls: Array<{ input: string; result: string }> }
        expect(JSON.parse(result.toolCalls[0]!.input)).toEqual({ command: 'read', args: [{ label: 'safe' }] })
        expect(JSON.parse(result.toolCalls[0]!.result)).toEqual({ text: 'Bearer [omitted]', query: 'lookup?token=[omitted]' })
    })

    it('scrubs JSON string results and omits malformed structured telemetry', async () => {
        const call = desktopTeamToolCallView({
            stepNumber: 1, toolName: 'mcp_example', isError: false, durationMs: 4,
            inputJson: '{"token":"damaged-row-secret"',
            resultJson: JSON.stringify(JSON.stringify({ content: [{ text: JSON.stringify({ apiKey: 'fixture-key', title: 'safe' }) }] })),
        })
        expect.soft(call.input).toBeNull()
        const result = JSON.parse(JSON.parse(call.result!))
        expect(JSON.parse(result.content[0].text)).toEqual({ title: 'safe' })
    })

    it('refuses an oversized result instead of returning part of it', async () => {
        const box = harness()
        box.schedules.mockResolvedValueOnce(ready([{ slug: 'daily', name: 'Daily', description: '', body: 'y'.repeat(200_001), cron: null, runAt: null, timezone: null, enabled: true, lastRunAt: null }]))
        await expect(box.call('team_list_schedules', { agentId: 'pub-b' })).rejects.toThrow(/over the 200000 limit/)
        expect(box.schedules).toHaveBeenCalledTimes(1)
    })
})

describe('desktop team read adapters', () => {
    it('does not follow a schedule alias or retry a failed definition read', async () => {
        const list = vi.fn(async () => [])
        expect(await readDesktopTeamSchedules('eng-b', { lstat: async () => ({ isSymbolicLink: true, isDirectory: true }), list })).toEqual({ acknowledgement: 'uncertain' })
        expect(list).not.toHaveBeenCalled()
        expect(await readDesktopTeamSchedules('eng-b', { lstat: async () => null, list })).toEqual({ acknowledgement: 'ready', value: [] })
        const triggerList = vi.fn(async () => { throw new Error('Unsafe trigger directory') })
        expect(await readDesktopTeamTriggers('eng-b', { list: triggerList })).toEqual({ acknowledgement: 'uncertain' })
        expect(triggerList).toHaveBeenCalledTimes(1)
    })

    it('inspects a saved run without starting one', async () => {
        const getRun = vi.fn(async () => { throw new Error('closed') })
        expect(await readDesktopTeamAdmit({ agentId: 'eng-a', runId: 'run-a', sessionId: 'sess-a' }, { getRun })).toBe('uncertain')
        expect(getRun).toHaveBeenCalledTimes(1)
        expect(await readDesktopTeamAdmit({ agentId: 'eng-a', runId: 'run-a', sessionId: 'sess-a' }, { getRun: async () => ({ agentId: 'eng-a', sessionId: 'sess-a', status: 'done' }) })).toBe('refused')
        expect(await readDesktopTeamAdmit({ agentId: 'eng-a' }, { getRun: async () => { throw new Error('no') } })).toBe('refused')
        const output = vi.fn(async () => 'hello')
        expect(await readDesktopTeamRun('eng-b', 'run-b', { getRun: async () => ({ id: 'run-b', agentId: 'other', status: 'done', sessionId: 's', provider: null, model: null, triggerSource: null, triggerSlug: null, stepCount: 0, inputTokens: null, outputTokens: null, totalTokens: null, costMicros: null, startedAt: 't', finishedAt: null, error: null }), output })).toEqual({ acknowledgement: 'ready', value: null })
        expect(output).not.toHaveBeenCalled()
        const listed = vi.fn(async () => { throw new Error('closed') })
        expect(await readDesktopTeamActivity('eng-b', { listRuns: listed, listSessions: async () => [] })).toEqual({ acknowledgement: 'uncertain' })
        expect(listed).toHaveBeenCalledTimes(1)
    })
})

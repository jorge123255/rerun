import { tool, type ToolSet } from 'ai'
import { z } from 'zod'
import {
    DESKTOP_TEAM_READ_AGENT_FILTER,
    DESKTOP_TEAM_READ_AGENT_ID,
    DESKTOP_TEAM_READ_DESCRIPTIONS as D,
    DESKTOP_TEAM_READ_LIMIT,
    DESKTOP_TEAM_READ_MESSAGES as M,
} from '@rerun/contracts'
import { desktopTeamAgentIdProblem, desktopTeamMemberStatus, desktopTeamPayload, desktopTeamRunLimit, desktopTeamScrub, desktopTeamTruncateField } from './project.js'
import type { DesktopTeamActivity, DesktopTeamAdmit, DesktopTeamCaller, DesktopTeamDirectory, DesktopTeamMember, DesktopTeamReadAck, DesktopTeamReadToolContext, DesktopTeamReads } from './ports.js'

const agentId = z.string().describe(DESKTOP_TEAM_READ_AGENT_ID)
const statusInput = z.object({ agentId: agentId.optional().describe(DESKTOP_TEAM_READ_AGENT_FILTER) })
const targetInput = z.object({ agentId })
const runsInput = z.object({ agentId, limit: z.number().optional().describe(DESKTOP_TEAM_READ_LIMIT) })
const runInput = z.object({ agentId, runId: z.string(), includeToolCalls: z.boolean().optional() })

export type DesktopTeamReadBindingInput = {
    grant: (engineAgentId: string) => Promise<boolean>
    admit: DesktopTeamAdmit
    directory: DesktopTeamDirectory
    reads: DesktopTeamReads
}

function assertAuthority(input: DesktopTeamReadBindingInput): void {
    const reads = input?.reads
    const directory = input?.directory
    if (typeof input?.grant !== 'function' || typeof input?.admit !== 'function') throw new Error('Desktop team read authority is required')
    if (!directory || typeof directory.caller !== 'function' || typeof directory.members !== 'function' || typeof directory.lookup !== 'function') throw new Error('Desktop team read authority is required')
    if (!reads || typeof reads.schedules !== 'function' || typeof reads.triggers !== 'function' || typeof reads.runs !== 'function' || typeof reads.run !== 'function' || typeof reads.toolCalls !== 'function' || typeof reads.activity !== 'function') throw new Error('Desktop team read authority is required')
}

function stop(ctx: DesktopTeamReadToolContext): void {
    if (ctx.abortSignal?.aborted) throw new Error(M.runClosed)
}

async function once<T>(ctx: DesktopTeamReadToolContext, read: () => Promise<T>): Promise<T> {
    stop(ctx)
    try {
        const result = await read()
        stop(ctx)
        return result
    } catch (error) {
        if (error instanceof Error && (error.message === M.runClosed || error.message === M.unavailable || error.message === M.switchedOff)) throw error
        if (ctx.abortSignal?.aborted) throw new Error(M.runClosed)
        throw new Error(M.unavailable)
    }
}

function unwrap<T>(result: DesktopTeamReadAck<T>): T {
    if (!result || result.acknowledgement !== 'ready') throw new Error(M.unavailable)
    return result.value
}

function parse<T>(schema: z.ZodType<T>, args: unknown): T {
    const parsed = schema.safeParse(args ?? {})
    if (!parsed.success) throw new Error(M.malformed)
    return parsed.data
}

export function createDesktopTeamReadTools(input: DesktopTeamReadBindingInput) {
    assertAuthority(input)
    const { grant, admit, directory, reads } = input

    async function requireActiveAuthority(ctx: DesktopTeamReadToolContext): Promise<void> {
        const allowed = await once(ctx, () => grant(ctx.agent.id))
        if (allowed !== true) throw new Error(M.switchedOff)
        const admission = await once(ctx, () => admit({ agentId: ctx.agent.id, runId: ctx.runId, sessionId: ctx.sessionId }))
        if (admission === 'uncertain') throw new Error(M.unavailable)
        if (admission !== 'ok') throw new Error(M.runClosed)
    }

    async function guardedRead<T>(ctx: DesktopTeamReadToolContext, read: () => Promise<T>): Promise<T> {
        await requireActiveAuthority(ctx)
        const result = await once(ctx, read)
        await requireActiveAuthority(ctx)
        return result
    }

    async function authorize(ctx: DesktopTeamReadToolContext): Promise<DesktopTeamCaller> {
        await requireActiveAuthority(ctx)
        const caller = await once(ctx, () => directory.caller(ctx.agent.id))
        if (caller === 'uncertain') throw new Error(M.unavailable)
        if (!caller || caller.engineAgentId !== ctx.agent.id || !caller.workspaceId) throw new Error(M.workspaceUnbound)
        return caller
    }

    async function target(ctx: DesktopTeamReadToolContext, caller: DesktopTeamCaller, id: string): Promise<DesktopTeamMember> {
        if (desktopTeamAgentIdProblem(id)) throw new Error(M.malformed)
        const found = await guardedRead(ctx, () => directory.lookup(caller.workspaceId, id))
        if (found.kind === 'uncertain') throw new Error(M.unavailable)
        if (found.kind === 'other-workspace') throw new Error(M.otherWorkspace)
        if (found.kind !== 'member') throw new Error(M.notFound)
        if (found.member.publicId !== id && found.member.engineAgentId !== id) throw new Error(M.notFound)
        return found.member
    }

    function engineId(member: DesktopTeamMember): string {
        if (!member.configured || !member.engineAgentId || desktopTeamAgentIdProblem(member.engineAgentId)) throw new Error(M.notFound)
        return member.engineAgentId
    }

    function finish(name: string, value: unknown): unknown {
        return desktopTeamPayload(name, desktopTeamScrub(value))
    }

    function statusOf(member: DesktopTeamMember, activity: DesktopTeamActivity | null, reachable: boolean) {
        const waitingOn = activity?.waitingOn ?? []
        const running = activity?.running ?? []
        const lastRun = activity?.lastFinished ?? null
        return {
            id: member.publicId,
            name: member.name,
            handle: member.handle,
            spaceId: member.spaceId,
            status: desktopTeamMemberStatus({
                switchedOff: !member.enabled || member.deleting,
                configured: member.configured && member.engineAgentId.length > 0,
                reachable,
                runningCount: running.length,
                waitingCount: waitingOn.length,
                lastFinishedStatus: lastRun?.status ?? null,
            }),
            running,
            waitingOn,
            lastRun: lastRun && { runId: lastRun.runId, status: lastRun.status, finishedAt: lastRun.finishedAt, error: lastRun.error },
        }
    }

    async function memberStatus(ctx: DesktopTeamReadToolContext, member: DesktopTeamMember) {
        if (!member.configured || !member.engineAgentId || member.reachable === false) return statusOf(member, null, false)
        const activity = unwrap(await guardedRead(ctx, () => reads.activity(member.engineAgentId)))
        return statusOf(member, activity, true)
    }

    return {
        tools(ctx: DesktopTeamReadToolContext): ToolSet {
            return {
                team_status: tool({
                    description: D.team_status,
                    inputSchema: statusInput,
                    execute: async args => {
                        const parsed = parse(statusInput, args)
                        if (parsed.agentId !== undefined && desktopTeamAgentIdProblem(parsed.agentId)) throw new Error(M.malformed)
                        const caller = await authorize(ctx)
                        if (parsed.agentId === undefined) {
                            const members = unwrap(await guardedRead(ctx, () => directory.members(caller.workspaceId)))
                            const agents = []
                            for (const member of members) agents.push(await memberStatus(ctx, member))
                            return finish('team_status', { checkedAt: new Date().toISOString(), agents })
                        }
                        const member = await target(ctx, caller, parsed.agentId)
                        return finish('team_status', { checkedAt: new Date().toISOString(), agents: [await memberStatus(ctx, member)] })
                    },
                }),
                team_list_schedules: tool({
                    description: D.team_list_schedules,
                    inputSchema: targetInput,
                    execute: async args => {
                        const parsed = parse(targetInput, args)
                        const caller = await authorize(ctx)
                        const member = await target(ctx, caller, parsed.agentId)
                        const schedules = unwrap(await guardedRead(ctx, () => reads.schedules(engineId(member))))
                        return finish('team_list_schedules', { schedules })
                    },
                }),
                team_list_triggers: tool({
                    description: D.team_list_triggers,
                    inputSchema: targetInput,
                    execute: async args => {
                        const parsed = parse(targetInput, args)
                        const caller = await authorize(ctx)
                        const member = await target(ctx, caller, parsed.agentId)
                        const triggers = unwrap(await guardedRead(ctx, () => reads.triggers(engineId(member))))
                        return finish('team_list_triggers', { triggers })
                    },
                }),
                team_list_runs: tool({
                    description: D.team_list_runs,
                    inputSchema: runsInput,
                    execute: async args => {
                        const parsed = parse(runsInput, args)
                        const caller = await authorize(ctx)
                        const member = await target(ctx, caller, parsed.agentId)
                        const limit = desktopTeamRunLimit(parsed.limit)
                        const listed = unwrap(await guardedRead(ctx, () => reads.runs(engineId(member), limit)))
                        return finish('team_list_runs', { runs: listed })
                    },
                }),
                team_get_run: tool({
                    description: D.team_get_run,
                    inputSchema: runInput,
                    execute: async args => {
                        const parsed = parse(runInput, args)
                        if (desktopTeamAgentIdProblem(parsed.runId)) throw new Error(M.malformed)
                        const caller = await authorize(ctx)
                        const member = await target(ctx, caller, parsed.agentId)
                        const id = engineId(member)
                        const run = unwrap(await guardedRead(ctx, () => reads.run(id, parsed.runId)))
                        if (!run) throw new Error(M.runNotFound)
                        if (parsed.includeToolCalls !== true) return finish('team_get_run', run)
                        const toolCalls = unwrap(await guardedRead(ctx, () => reads.toolCalls(id, parsed.runId)))
                        return finish('team_get_run', { ...run, toolCalls: toolCalls.map(call => ({ ...call, input: desktopTeamTruncateField(call.input), result: desktopTeamTruncateField(call.result) })) })
                    },
                }),
            }
        },
    }
}

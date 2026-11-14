import {
    FOREMAN_WORKSPACE_READ_DESCRIPTION_LIMIT,
    FOREMAN_WORKSPACE_READ_DESCRIPTIONS as D,
    FOREMAN_WORKSPACE_READ_MESSAGES as M,
    type ForemanWorkspaceRosterRow,
} from '@rerun/contracts'
import { tool, type ToolSet } from 'ai'
import { z } from 'zod'
import type { DesktopTeamMember } from '../team-reads/ports.js'
import { desktopTeamAgentIdProblem } from '../team-reads/project.js'
import type { ForemanWorkspaceReadContext, ForemanWorkspaceReadPorts } from './ports.js'
import {
    assertForemanWorkspaceRowCount,
    foremanWorkspaceFingerprint,
    foremanWorkspaceResult,
    foremanWorkspaceScheduleRows,
    foremanWorkspaceText,
    foremanWorkspaceTriggerRows,
    parseForemanWorkspaceSnapshot,
    type ReadySnapshot,
} from './project.js'

const revisionField = z.number().int().nonnegative().optional()
const spacesInput = z.strictObject({ revision: revisionField })
const agentsInput = z.strictObject({ spaceId: z.string().optional(), revision: revisionField })
const agentInput = z.strictObject({ agentId: z.string(), revision: revisionField })
const KNOWN = new Set<string>([
    ...Object.values(M),
    'Foreman launch changed.',
    'This Foreman run is no longer active.',
])

function parse<T>(schema: z.ZodType<T>, args: unknown): T {
    const parsed = schema.safeParse(args ?? {})
    if (!parsed.success) throw new Error(M.malformed)
    return parsed.data
}

function sameIds(left: string[], right: string[]): boolean {
    if (left.length !== right.length) return false
    const a = new Set(left)
    const b = new Set(right)
    if (a.size !== left.length || b.size !== right.length) return false
    for (const id of a) if (!b.has(id)) return false
    return true
}

export function createForemanWorkspaceReadTools(ports: ForemanWorkspaceReadPorts) {
    if (typeof ports?.grant !== 'function' || typeof ports?.snapshot !== 'function' || typeof ports?.schedules !== 'function' || typeof ports?.triggers !== 'function') throw new Error('Foreman workspace read authority is required')
    if (typeof ports.directory?.members !== 'function' || typeof ports.directory?.lookup !== 'function') throw new Error('Foreman workspace read authority is required')

    function fail(error: unknown, signal: AbortSignal): never {
        if (signal.aborted) throw new Error(M.runClosed)
        if (error instanceof Error && KNOWN.has(error.message)) throw error
        throw new Error(M.unavailable)
    }

    async function readySnapshot(ctx: ForemanWorkspaceReadContext): Promise<ReadySnapshot> {
        const workspaceId = ctx.binding.workspaceId
        if (!workspaceId || workspaceId.length > 128 || workspaceId !== workspaceId.trim()) throw new Error(M.malformed)
        ctx.signal.throwIfAborted()
        await ctx.assertCurrent()
        if (await ports.grant(workspaceId) !== true) throw new Error(M.refused)
        const first = classify(parseForemanWorkspaceSnapshot(await ports.snapshot(ctx.binding, ctx.signal)), workspaceId)
        await ctx.assertCurrent()
        if (await ports.grant(workspaceId) !== true) throw new Error(M.refused)
        const second = classify(parseForemanWorkspaceSnapshot(await ports.snapshot(ctx.binding, ctx.signal)), workspaceId)
        await ctx.assertCurrent()
        if (await ports.grant(workspaceId) !== true) throw new Error(M.refused)
        if (foremanWorkspaceFingerprint(first) !== foremanWorkspaceFingerprint(second)) throw new Error(M.stale)
        return second
    }

    function classify(snapshot: ReturnType<typeof parseForemanWorkspaceSnapshot>, workspaceId: string): ReadySnapshot {
        if (snapshot.kind === 'revoked' || snapshot.kind === 'missing') throw new Error(M.refused)
        if (snapshot.kind === 'other-workspace') throw new Error(M.otherWorkspace)
        if (snapshot.kind !== 'ready') throw new Error(M.unavailable)
        if (snapshot.workspaceId !== workspaceId) throw new Error(M.otherWorkspace)
        const boxIds = snapshot.boxes.map(box => box.id)
        const rosterIds = snapshot.roster.map(row => row.id)
        if (!sameIds(boxIds, [...new Set(boxIds)]) || !sameIds(rosterIds, [...new Set(rosterIds)]) || !sameIds(snapshot.foreignIds, [...new Set(snapshot.foreignIds)])) throw new Error(M.unavailable)
        if (snapshot.roster.some(row => row.workspaceId !== workspaceId)) throw new Error(M.unavailable)
        if (snapshot.roster.some(row => snapshot.foreignIds.includes(row.id))) throw new Error(M.unavailable)
        if (snapshot.roster.some(row => row.spaceId !== null && desktopTeamAgentIdProblem(row.spaceId))) throw new Error(M.unavailable)
        return snapshot
    }

    function pin(snapshot: ReadySnapshot, revision: number | undefined): void {
        if (revision !== undefined && revision !== snapshot.revision) throw new Error(M.stale)
    }

    async function confirmedRoster(ctx: ForemanWorkspaceReadContext, snapshot: ReadySnapshot): Promise<{ snapshot: ReadySnapshot; rows: ForemanWorkspaceRosterRow[]; members: Map<string, DesktopTeamMember> }> {
        const listed = await ports.directory.members(snapshot.catalogWorkspaceId)
        if (!listed || listed.acknowledgement !== 'ready') throw new Error(M.unavailable)
        await ctx.assertCurrent()
        if (await ports.grant(ctx.binding.workspaceId) !== true) throw new Error(M.refused)
        const again = classify(parseForemanWorkspaceSnapshot(await ports.snapshot(ctx.binding, ctx.signal)), ctx.binding.workspaceId)
        await ctx.assertCurrent()
        if (await ports.grant(ctx.binding.workspaceId) !== true) throw new Error(M.refused)
        if (foremanWorkspaceFingerprint(snapshot) !== foremanWorkspaceFingerprint(again)) throw new Error(M.stale)
        const members = new Map(listed.value.map(member => [member.publicId, member]))
        if (!sameIds(snapshot.roster.map(row => row.id), [...members.keys()])) throw new Error(M.unavailable)
        const rows = snapshot.roster.map(row => {
            const member = members.get(row.id)
            if (!member || member.publicId !== row.id) throw new Error(M.unavailable)
            if (member.spaceId !== row.spaceId || member.name !== row.name || member.enabled !== row.enabled) throw new Error(M.stale)
            return {
                ...row,
                name: member.name,
                handle: member.handle,
                spaceId: member.spaceId ?? row.spaceId,
                enabled: member.enabled && !member.deleting,
                deleting: member.deleting,
            }
        })
        return { snapshot: again, rows, members }
    }

    function projectAgent(row: ForemanWorkspaceRosterRow) {
        return {
            id: row.id,
            name: foremanWorkspaceText(row.name, FOREMAN_WORKSPACE_READ_DESCRIPTION_LIMIT),
            handle: row.handle === null ? null : foremanWorkspaceText(row.handle, FOREMAN_WORKSPACE_READ_DESCRIPTION_LIMIT),
            description: foremanWorkspaceText(row.description, FOREMAN_WORKSPACE_READ_DESCRIPTION_LIMIT),
            spaceId: row.spaceId,
            enabled: row.enabled && !row.deleting,
        }
    }

    async function target(ctx: ForemanWorkspaceReadContext, snapshot: ReadySnapshot, agentId: string, members: Map<string, DesktopTeamMember>): Promise<DesktopTeamMember> {
        if (desktopTeamAgentIdProblem(agentId)) throw new Error(M.malformed)
        if (snapshot.foreignIds.includes(agentId)) throw new Error(M.otherWorkspace)
        const found = await ports.directory.lookup(snapshot.catalogWorkspaceId, agentId)
        if (!found || found.kind === 'uncertain') throw new Error(M.unavailable)
        if (found.kind === 'other-workspace') throw new Error(M.otherWorkspace)
        if (found.kind !== 'member') throw new Error(M.notFound)
        const member = members.get(agentId)
        if (!member || member.publicId !== found.member.publicId || member.deleting || found.member.deleting) throw new Error(M.notFound)
        if (member.engineAgentId !== found.member.engineAgentId) throw new Error(M.unavailable)
        await ctx.assertCurrent()
        if (await ports.grant(ctx.binding.workspaceId) !== true) throw new Error(M.refused)
        return found.member
    }

    return {
        tools(ctx: ForemanWorkspaceReadContext): ToolSet {
            const run = async <T>(read: () => Promise<T>): Promise<T> => {
                try {
                    return await read()
                } catch (error) {
                    fail(error, ctx.signal)
                }
            }
            return {
                list_spaces: tool({
                    description: D.list_spaces,
                    inputSchema: spacesInput,
                    execute: async args => run(async () => {
                        const parsed = parse(spacesInput, args)
                        const snapshot = await readySnapshot(ctx)
                        pin(snapshot, parsed.revision)
                        const { rows } = await confirmedRoster(ctx, snapshot)
                        assertForemanWorkspaceRowCount(snapshot.boxes.length)
                        const spaces = snapshot.boxes.map(box => ({
                            id: box.id,
                            name: foremanWorkspaceText(box.name, FOREMAN_WORKSPACE_READ_DESCRIPTION_LIMIT),
                            agentCount: rows.filter(row => row.spaceId === box.id).length,
                        }))
                        return foremanWorkspaceResult('list_spaces', { revision: snapshot.revision, spaces })
                    }),
                }),
                list_agents: tool({
                    description: D.list_agents,
                    inputSchema: agentsInput,
                    execute: async args => run(async () => {
                        const parsed = parse(agentsInput, args)
                        if (parsed.spaceId !== undefined && desktopTeamAgentIdProblem(parsed.spaceId)) throw new Error(M.malformed)
                        const snapshot = await readySnapshot(ctx)
                        pin(snapshot, parsed.revision)
                        if (parsed.spaceId !== undefined && !snapshot.boxes.some(box => box.id === parsed.spaceId)) throw new Error(M.notFound)
                        const { rows } = await confirmedRoster(ctx, snapshot)
                        const agents = rows.filter(row => parsed.spaceId === undefined || row.spaceId === parsed.spaceId)
                        assertForemanWorkspaceRowCount(agents.length)
                        return foremanWorkspaceResult('list_agents', { revision: snapshot.revision, agents: agents.map(projectAgent) })
                    }),
                }),
                list_schedules: tool({
                    description: D.list_schedules,
                    inputSchema: agentInput,
                    execute: async args => run(async () => {
                        const parsed = parse(agentInput, args)
                        const snapshot = await readySnapshot(ctx)
                        pin(snapshot, parsed.revision)
                        const { members } = await confirmedRoster(ctx, snapshot)
                        const member = await target(ctx, snapshot, parsed.agentId, members)
                        const schedules = !member.configured || !member.engineAgentId || desktopTeamAgentIdProblem(member.engineAgentId)
                            ? []
                            : unwrap(await ports.schedules(member.engineAgentId))
                        await ctx.assertCurrent()
                        if (await ports.grant(ctx.binding.workspaceId) !== true) throw new Error(M.refused)
                        return foremanWorkspaceResult('list_schedules', { revision: snapshot.revision, agentId: member.publicId, schedules: foremanWorkspaceScheduleRows(schedules) })
                    }),
                }),
                list_triggers: tool({
                    description: D.list_triggers,
                    inputSchema: agentInput,
                    execute: async args => run(async () => {
                        const parsed = parse(agentInput, args)
                        const snapshot = await readySnapshot(ctx)
                        pin(snapshot, parsed.revision)
                        const { members } = await confirmedRoster(ctx, snapshot)
                        const member = await target(ctx, snapshot, parsed.agentId, members)
                        const triggers = !member.configured || !member.engineAgentId || desktopTeamAgentIdProblem(member.engineAgentId)
                            ? []
                            : unwrap(await ports.triggers(member.engineAgentId))
                        await ctx.assertCurrent()
                        if (await ports.grant(ctx.binding.workspaceId) !== true) throw new Error(M.refused)
                        return foremanWorkspaceResult('list_triggers', { revision: snapshot.revision, agentId: member.publicId, triggers: foremanWorkspaceTriggerRows(triggers) })
                    }),
                }),
            }
        },
    }
}

function unwrap<T>(result: { acknowledgement?: string; value?: T }): T {
    if (!result || result.acknowledgement !== 'ready' || result.value === undefined) throw new Error(M.unavailable)
    return result.value
}

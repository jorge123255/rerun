import { realpath } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { dataDir, isPathSegment, schedulesDir, triggersDir } from '../../config/paths.js'
import { openWithoutLinks, readBoundedFileWithoutLinks } from '../open-without-links.js'
import { desktopTeamActivityFrom, desktopTeamRunView, desktopTeamScheduleView, desktopTeamToolCallView, desktopTeamTriggerView } from './project.js'
import type { DesktopTeamActivity, DesktopTeamAdmitContext, DesktopTeamReadAck, DesktopTeamReads, DesktopTeamRunDetail, DesktopTeamRunView, DesktopTeamScheduleView, DesktopTeamToolCallView, DesktopTeamTriggerView } from './ports.js'

type DirStat = { isSymbolicLink: boolean; isDirectory: boolean }

const uncertain = { acknowledgement: 'uncertain' as const }
const ready = <T>(value: T): DesktopTeamReadAck<T> => ({ acknowledgement: 'ready', value })
const MAX_SCHEDULE_BYTES = 256 * 1024

function missing(error: unknown): boolean {
    return (error as NodeJS.ErrnoException).code === 'ENOENT'
}

async function directoryStat(path: string): Promise<DirStat | null> {
    const { lstat } = await import('node:fs/promises')
    try {
        const stat = await lstat(path)
        return { isSymbolicLink: stat.isSymbolicLink(), isDirectory: stat.isDirectory() }
    } catch (error) {
        if (missing(error)) return null
        throw error
    }
}

export type DesktopTeamScheduleDeps = {
    lstat(engineAgentId: string): Promise<DirStat | null>
    list(engineAgentId: string): Promise<Array<Parameters<typeof desktopTeamScheduleView>[0]>>
}

function defaultScheduleDeps(): DesktopTeamScheduleDeps {
    return {
        async lstat(id) {
            try {
                const root = dataDir()
                const path = join(await realpath(root), relative(root, schedulesDir(id)))
                const handle = await openWithoutLinks(path, true)
                await handle.close()
                return { isDirectory: true, isSymbolicLink: false }
            } catch (error) {
                if (missing(error)) return null
                throw error
            }
        },
        async list(id) {
            const { listSchedules } = await import('../../schedules/loader.js')
            const root = dataDir()
            const canonical = await realpath(root)
            return listSchedules(id, async path =>
                (await readBoundedFileWithoutLinks(join(canonical, relative(root, path)), MAX_SCHEDULE_BYTES)).toString('utf8'))
        },
    }
}

/** Read saved schedule files. Does not run a schedule. A symlinked directory is not followed. */
export async function readDesktopTeamSchedules(engineAgentId: string, deps: DesktopTeamScheduleDeps = defaultScheduleDeps()): Promise<DesktopTeamReadAck<DesktopTeamScheduleView[]>> {
    if (!isPathSegment(engineAgentId)) return uncertain
    try {
        const stat = await deps.lstat(engineAgentId)
        if (!stat) return ready([])
        if (stat.isSymbolicLink || !stat.isDirectory) return uncertain
        const rows = await deps.list(engineAgentId)
        return ready(rows.map(row => desktopTeamScheduleView(row)))
    } catch { return uncertain }
}

export type DesktopTeamTriggerDeps = {
    list(engineAgentId: string): Promise<Array<Parameters<typeof desktopTeamTriggerView>[0]>>
}

function defaultTriggerDeps(): DesktopTeamTriggerDeps {
    return {
        async list(id) {
            const stat = await directoryStat(triggersDir(id))
            if (!stat) return []
            if (stat.isSymbolicLink || !stat.isDirectory) throw new Error('Unsafe trigger directory')
            const { listDesktopTriggerDefinitions } = await import('../triggers/definitions.js')
            return listDesktopTriggerDefinitions(id)
        },
    }
}

/** Read trigger definitions. Drops token and url. Does not fire, rotate, or replace a trigger. */
export async function readDesktopTeamTriggers(engineAgentId: string, deps: DesktopTeamTriggerDeps = defaultTriggerDeps()): Promise<DesktopTeamReadAck<DesktopTeamTriggerView[]>> {
    if (!isPathSegment(engineAgentId)) return uncertain
    try {
        return ready((await deps.list(engineAgentId)).map(row => desktopTeamTriggerView(row)))
    } catch { return uncertain }
}

type RunRow = Parameters<typeof desktopTeamRunView>[0]

export type DesktopTeamRunDeps = {
    listRuns(engineAgentId: string, filter: { limit?: number; status?: string }): Promise<RunRow[]>
}

function defaultRunDeps(): DesktopTeamRunDeps {
    return {
        async listRuns(id, filter) {
            const { listRunsByAgent } = await import('../../db/repos/runs.js')
            return listRunsByAgent(id, filter)
        },
    }
}

export async function readDesktopTeamRuns(engineAgentId: string, limit: number, deps: DesktopTeamRunDeps = defaultRunDeps()): Promise<DesktopTeamReadAck<DesktopTeamRunView[]>> {
    if (!isPathSegment(engineAgentId)) return uncertain
    try {
        const rows = await deps.listRuns(engineAgentId, { limit })
        return ready(rows.filter(row => row.id && row.sessionId).map(row => desktopTeamRunView(row)))
    } catch { return uncertain }
}

export type DesktopTeamRunDetailDeps = {
    getRun(engineAgentId: string, runId: string): Promise<(RunRow & { agentId?: string; output?: string | null }) | null | undefined>
    output(engineAgentId: string, sessionId: string, startedAt: string, finishedAt: string | null): Promise<string>
}

function defaultRunDetailDeps(): DesktopTeamRunDetailDeps {
    return {
        async getRun(id, runId) {
            const { getRun } = await import('../../db/repos/runs.js')
            return getRun(id, runId)
        },
        async output(id, sessionId, startedAt, finishedAt) {
            const { collectAssistantText } = await import('../../db/repos/messages.js')
            return collectAssistantText(id, sessionId, startedAt, finishedAt)
        },
    }
}

/** Saved run row and saved assistant text. Does not start or continue the run. */
export async function readDesktopTeamRun(engineAgentId: string, runId: string, deps: DesktopTeamRunDetailDeps = defaultRunDetailDeps()): Promise<DesktopTeamReadAck<DesktopTeamRunDetail | null>> {
    if (!isPathSegment(engineAgentId) || !isPathSegment(runId)) return uncertain
    try {
        const row = await deps.getRun(engineAgentId, runId)
        if (!row || (row.agentId !== undefined && row.agentId !== engineAgentId)) return ready(null)
        const text = await deps.output(engineAgentId, row.sessionId, row.startedAt, row.finishedAt)
        return ready({ ...desktopTeamRunView(row), output: text.length > 0 ? text : null })
    } catch { return uncertain }
}

export type DesktopTeamToolCallDeps = {
    list(engineAgentId: string, runId: string): Promise<Array<Parameters<typeof desktopTeamToolCallView>[0] & { agentId?: string; runId?: string }>>
}

function defaultToolCallDeps(): DesktopTeamToolCallDeps {
    return {
        async list(id, runId) {
            const { listToolCalls } = await import('../../db/repos/telemetry.js')
            return listToolCalls(id, runId)
        },
    }
}

export async function readDesktopTeamToolCalls(engineAgentId: string, runId: string, deps: DesktopTeamToolCallDeps = defaultToolCallDeps()): Promise<DesktopTeamReadAck<DesktopTeamToolCallView[]>> {
    if (!isPathSegment(engineAgentId) || !isPathSegment(runId)) return uncertain
    try {
        const rows = await deps.list(engineAgentId, runId)
        return ready(rows.filter(row => (row.agentId === undefined || row.agentId === engineAgentId) && (row.runId === undefined || row.runId === runId)).map(row => desktopTeamToolCallView(row)))
    } catch { return uncertain }
}

export type DesktopTeamActivityDeps = {
    listRuns(engineAgentId: string, filter: { limit?: number; status?: string }): Promise<RunRow[]>
    listSessions(engineAgentId: string): Promise<Array<{ id: string; status: string }>>
}

function defaultActivityDeps(): DesktopTeamActivityDeps {
    return {
        async listRuns(id, filter) {
            const { listRunsByAgent } = await import('../../db/repos/runs.js')
            return listRunsByAgent(id, filter)
        },
        async listSessions(id) {
            const { listSessions } = await import('../../db/repos/sessions.js')
            return listSessions(id)
        },
    }
}

export async function readDesktopTeamActivity(engineAgentId: string, deps: DesktopTeamActivityDeps = defaultActivityDeps()): Promise<DesktopTeamReadAck<DesktopTeamActivity>> {
    if (!isPathSegment(engineAgentId)) return uncertain
    try {
        const running = await deps.listRuns(engineAgentId, { status: 'running', limit: 20 })
        const recent = await deps.listRuns(engineAgentId, { limit: 5 })
        const sessions = await deps.listSessions(engineAgentId)
        return ready(desktopTeamActivityFrom(running, recent, sessions))
    } catch { return uncertain }
}

export function desktopTeamReadPorts(): DesktopTeamReads {
    return {
        schedules: id => readDesktopTeamSchedules(id),
        triggers: id => readDesktopTeamTriggers(id),
        runs: (id, limit) => readDesktopTeamRuns(id, limit),
        run: (id, runId) => readDesktopTeamRun(id, runId),
        toolCalls: (id, runId) => readDesktopTeamToolCalls(id, runId),
        activity: id => readDesktopTeamActivity(id),
    }
}

export type DesktopTeamAdmitDeps = {
    getRun(engineAgentId: string, runId: string): Promise<{ agentId: string; sessionId: string; status: string } | null | undefined>
}

function defaultAdmitDeps(): DesktopTeamAdmitDeps {
    return {
        async getRun(id, runId) {
            const { getRun } = await import('../../db/repos/runs.js')
            return getRun(id, runId)
        },
    }
}

/** One read of the caller's saved run. Missing, finished, or mismatched identity refuses. A thrown read is uncertain and is not repeated here. */
export async function readDesktopTeamAdmit(ctx: DesktopTeamAdmitContext, deps: DesktopTeamAdmitDeps = defaultAdmitDeps()): Promise<'ok' | 'uncertain' | 'refused'> {
    if (!ctx.runId || !ctx.sessionId || !isPathSegment(ctx.agentId) || !isPathSegment(ctx.runId)) return 'refused'
    try {
        const run = await deps.getRun(ctx.agentId, ctx.runId)
        if (!run || run.agentId !== ctx.agentId || run.sessionId !== ctx.sessionId || run.status !== 'running') return 'refused'
        return 'ok'
    } catch { return 'uncertain' }
}

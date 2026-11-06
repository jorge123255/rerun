import 'server-only'
import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { ExternalMcpCallContext, ExternalMcpLiveCheckInput, ExternalMcpLiveCheckResult } from '@rerun/contracts'
import {
    agentDataBase,
    createSchedule,
    deleteSchedule,
    executeDb,
    getAgent,
    getRun,
    getRunTools,
    listDbTables,
    listRuns,
    listSchedules,
    patchAgent,
    queryDb,
    SPACE_DATA_BASE,
    updateSchedule,
} from '@/lib/engine/client'
import { desktopRunView } from '../../run-history'
import { DesktopHttpError } from '../auth'
import { createCoworkerSkill, deleteCoworkerSkill, getCoworkerSkill, listCoworkerSkills, readCoworkerSkillFile, updateCoworkerSkill, writeCoworkerSkillFile } from '../coworker-skills'
import { deleteDesktopCoworker } from '../coworker-delete'
import { renameDesktopCoworker } from '../coworker-rename'
import { startDesktopChat } from '../engine'
import { createDescribedDesktopCoworker } from '../new-agent'
import { authorizeDesktopSchedules } from '../schedules-binding'
import { listDesktopServiceCatalog } from '../services/catalog/index'
import { changeDesktopSettings, engineOf, readDesktopProviders } from '../settings'
import { planDesktopAgentPlacement, readDesktopBoardState, writeDesktopBoardState } from '../spaces'
import { listDesktopAgents } from '../store'
import { authorizeDesktopTriggers } from '../triggers/binding'
import { desktopTriggerEngine } from '../triggers/engine'
import { asString, externalMcpDb, externalMcpGuarded, externalMcpOwnedAgent, externalMcpRuntime, requireConfirm, requireString } from './guard'


function derivedRequestId(requestId: string, purpose: string): string {
    const hex = createHash('sha256').update(`external-mcp:${purpose}:${requestId}`).digest('hex')
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}

export type ExternalMcpServicesAuthority = {
    listInstalled(owner: string, signal: AbortSignal): Promise<Array<{ key: string; slug: string; status: string; toolNames: string[]; revision: string; name?: string }>>
    mutate(owner: string, input: Record<string, unknown>, signal: AbortSignal): Promise<unknown>
}

export type ExternalMcpOperationsDeps = {
    recheck: (input: ExternalMcpLiveCheckInput) => Promise<ExternalMcpLiveCheckResult>
    services?: ExternalMcpServicesAuthority
}

const id = z.string().min(1).max(256)

function messageOf(error: unknown): string {
    if (error instanceof DesktopHttpError) return error.message
    if (error instanceof Error && error.message) return error.message
    return 'Request failed.'
}

async function drain(response: Response) {
    if (!response.body) return
    await response.body.pipeTo(new WritableStream({ write() {} })).catch(() => {})
}

async function waitRun(engine: ReturnType<typeof engineOf>, engineAgentId: string, runId: string, waitSeconds: number, context: ExternalMcpCallContext, deps: ExternalMcpOperationsDeps, signal: AbortSignal) {
    const deadline = Date.now() + Math.min(Math.max(waitSeconds, 1), 600) * 1000
    while (Date.now() < deadline) {
        signal.throwIfAborted()
        await externalMcpGuarded(context, deps.recheck, signal, async () => undefined)
        const run = await getRun(engine, engineAgentId, runId, { signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]) })
        if (run.agentId !== engineAgentId || run.id !== runId) throw new Error('Run identity mismatch.')
        if (['done', 'error', 'cancelled'].includes(run.status)) return run
        await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(resolve, 1000)
            const onAbort = () => { clearTimeout(timer); reject(signal.reason ?? new Error('Aborted')) }
            if (signal.aborted) return onAbort()
            signal.addEventListener('abort', onAbort, { once: true })
        })
    }
    return getRun(engine, engineAgentId, runId, { signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]) })
}

function publicAgent(row: { id: string; name: string; description: string; spaceId?: string; enabled: boolean }) {
    return { id: row.id, name: row.name, description: row.description, spaceId: row.spaceId ?? null, enabled: row.enabled }
}

export async function invokeExternalMcpOperation(context: ExternalMcpCallContext, signal: AbortSignal, deps: ExternalMcpOperationsDeps): Promise<unknown> {
    const runtime = await externalMcpRuntime(context, deps.recheck, signal)
    const db = await externalMcpDb(runtime, context, deps.recheck, signal)
    const engine = engineOf(runtime)
    const args = context.arguments
    const tool = context.tool

    if (tool === 'list_spaces') {
        const board = await externalMcpGuarded(context, deps.recheck, signal, () => readDesktopBoardState(db))
        const agents = await externalMcpGuarded(context, deps.recheck, signal, () => listDesktopAgents(db))
        const owned = agents.filter(agent => agent.workspaceId === context.principal.workspaceId)
        return {
            spaces: board.spaces.map(space => ({
                id: space.id,
                name: space.name,
                agentCount: owned.filter(agent => agent.spaceId === space.id).length,
                access: 'full',
            })),
        }
    }

    if (tool === 'list_agents') {
        const parsed = z.strictObject({ spaceId: id.optional() }).parse(args)
        const rows = await externalMcpGuarded(context, deps.recheck, signal, () => listDesktopAgents(db))
        const owned = rows.filter(row => row.workspaceId === context.principal.workspaceId && (!parsed.spaceId || row.spaceId === parsed.spaceId))
        if (owned.length > 200) throw new Error('Too many coworkers. Narrow by Box.')
        return { agents: owned.map(publicAgent) }
    }

    if (tool === 'get_team_status') {
        const parsed = z.strictObject({ spaceId: id.optional(), agentId: id.optional() }).parse(args)
        const rows = await externalMcpGuarded(context, deps.recheck, signal, () => listDesktopAgents(db))
        let owned = rows.filter(row => row.workspaceId === context.principal.workspaceId)
        if (parsed.spaceId) owned = owned.filter(row => row.spaceId === parsed.spaceId)
        if (parsed.agentId) owned = owned.filter(row => row.id === parsed.agentId)
        if (owned.length > 50) throw new Error('Too many coworkers for team status. Narrow the request.')
        const agents = []
        for (const agent of owned) {
            signal.throwIfAborted()
            await externalMcpGuarded(context, deps.recheck, signal, async () => undefined)
            if (!agent.enabled) {
                agents.push({ id: agent.id, name: agent.name, status: 'disabled', enabled: false })
                continue
            }
            const runs = await listRuns(engine, agent.engineAgentId, { limit: 1 }, { signal })
            const latest = runs[0]
            agents.push({
                id: agent.id,
                name: agent.name,
                enabled: true,
                status: latest?.status ?? 'idle',
                runId: latest?.id ?? null,
                startedAt: latest?.startedAt ?? null,
            })
        }
        return { agents }
    }

    if (tool === 'get_agent') {
        const agentId = requireString(args.agentId, 'agentId')
        const agent = await externalMcpOwnedAgent(db, context, deps.recheck, signal, agentId)
        const unavailable: string[] = []
        const detail = await externalMcpGuarded(context, deps.recheck, signal, () => getAgent(engine, agent.engineAgentId))
        if (detail.id !== agent.engineAgentId) throw new Error('Coworker identity mismatch.')
        const skills = await externalMcpGuarded(context, deps.recheck, signal, () => listCoworkerSkills(runtime, agent.id)).catch(() => { unavailable.push('skills'); return [] })
        let schedules: unknown[] = []
        try {
            await authorizeDesktopSchedules(runtime, db, agent.engineAgentId, signal)
            schedules = await listSchedules(engine, agent.engineAgentId)
        } catch { unavailable.push('schedules') }
        let triggers: unknown[] = []
        try {
            await authorizeDesktopTriggers(runtime, db, agent.engineAgentId, signal)
            const listed = await desktopTriggerEngine(runtime, { op: 'list', localAgentId: agent.id, engineAgentId: agent.engineAgentId }, signal) as { triggers?: unknown[] }
            triggers = Array.isArray(listed?.triggers) ? listed.triggers.map((row: any) => {
                const { token, ...rest } = row ?? {}
                return rest
            }) : []
        } catch { unavailable.push('triggers') }
        return {
            ...publicAgent(agent),
            handle: detail.config.name,
            soul: detail.soul,
            description: detail.config.description ?? agent.description,
            verbosity: detail.config.verbosity,
            enabled: detail.config.enabled && agent.enabled,
            tools: detail.config.tools,
            selfImprovement: detail.config.selfImprovement,
            runsOn: { connectionId: detail.config.connectionId ?? null, provider: detail.config.provider ?? null, model: detail.config.model ?? null },
            skills: skills.map(skill => ({ slug: skill.slug, name: skill.name, description: skill.description })),
            schedules,
            triggers,
            unavailable,
        }
    }

    if (tool === 'create_agent') {
        const name = requireString(args.name, 'name').trim()
        if (name.length > 60) throw new Error('Keep the name under 60 characters.')
        const soul = asString(args.soul)?.trim()
        const description = asString(args.description)?.trim() ?? ''
        const kickoff = (soul && soul.slice(0, 2000)) || (description && `You are ${name}. ${description}`.slice(0, 2000))
        if (!kickoff) throw new Error('Local create_agent requires soul or description as the durable first instruction.')
        if (Array.isArray(args.connectors) && args.connectors.length) throw new Error('create_agent connectors require attach_connector after creation; pass no connectors on create.')
        if (runtime.workspaceId !== 1 || context.principal.workspaceId !== 1) throw new Error('Local coworker creation is only bound for workspace 1 on this prepared runtime.')
        let placement = await externalMcpGuarded(context, deps.recheck, signal, () => planDesktopAgentPlacement(db, asString(args.spaceId)))
        if (placement.createSpace) {
            const board = await externalMcpGuarded(context, deps.recheck, signal, () => readDesktopBoardState(db))
            await externalMcpGuarded(context, deps.recheck, signal, () => writeDesktopBoardState(db, {
                requestId: derivedRequestId(context.requestId, 'create-space'),
                expectedRevision: board.revision,
                command: { kind: 'create', name: placement.space.name },
            }))
            placement = await externalMcpGuarded(context, deps.recheck, signal, () => planDesktopAgentPlacement(db, asString(args.spaceId)))
            if (placement.createSpace) throw new Error('Could not place the coworker in a Box after creating one.')
        }
        const created = await externalMcpGuarded(context, deps.recheck, signal, () => createDescribedDesktopCoworker(runtime, {
            intent: { requestId: context.requestId, name, kickoff, suggestionId: null, scheduled: false },
            position: placement.position,
            spaceId: placement.space.id,
        }))
        const patch: Record<string, unknown> = {}
        if (soul) patch.soul = soul
        if (description) patch.description = description
        if (args.verbosity !== undefined) patch.verbosity = args.verbosity
        if (args.tools && typeof args.tools === 'object') patch.tools = args.tools
        if (args.selfImprovement && typeof args.selfImprovement === 'object') patch.selfImprovement = args.selfImprovement
        if (asString(args.connectionId) || asString(args.model) || asString(args.provider)) {
            if (asString(args.connectionId)) patch.connectionId = asString(args.connectionId)
            if (asString(args.model)) patch.model = asString(args.model)
            if (asString(args.provider)) patch.provider = asString(args.provider)
        }
        if (Object.keys(patch).length) {
            await externalMcpGuarded(context, deps.recheck, signal, () => patchAgent(engine, created.agent.engineAgentId, patch as never))
        }
        return { agent: publicAgent(created.agent), sessionId: created.sessionId, recovered: false }
    }

    if (tool === 'update_agent') {
        const agentId = requireString(args.agentId, 'agentId')
        const agent = await externalMcpOwnedAgent(db, context, deps.recheck, signal, agentId)
        if (asString(args.name) && asString(args.name) !== agent.name) {
            await externalMcpGuarded(context, deps.recheck, signal, () => renameDesktopCoworker(db, engine, runtime.launchNonce, agent.id, requireString(args.name, 'name').trim()))
        }
        if (asString(args.spaceId) && asString(args.spaceId) !== agent.spaceId) {
            const board = await externalMcpGuarded(context, deps.recheck, signal, () => readDesktopBoardState(db))
            await externalMcpGuarded(context, deps.recheck, signal, () => writeDesktopBoardState(db, {
                requestId: derivedRequestId(context.requestId, 'move-agent'),
                expectedRevision: board.revision,
                command: { kind: 'move-agent', agentId: agent.id, spaceId: requireString(args.spaceId, 'spaceId') },
            }))
        }
        const patch: Record<string, unknown> = {}
        if (asString(args.description) !== undefined) patch.description = asString(args.description)
        if (asString(args.soul) !== undefined) patch.soul = asString(args.soul)
        if (asString(args.handle) !== undefined) patch.name = asString(args.handle)
        if (args.verbosity !== undefined) patch.verbosity = args.verbosity
        if (args.tools && typeof args.tools === 'object') patch.tools = args.tools
        if (args.selfImprovement && typeof args.selfImprovement === 'object') patch.selfImprovement = args.selfImprovement
        if (asString(args.connectionId) !== undefined) patch.connectionId = asString(args.connectionId)
        if (asString(args.model) !== undefined) patch.model = asString(args.model)
        if (asString(args.provider) !== undefined) patch.provider = asString(args.provider)
        let detail = await externalMcpGuarded(context, deps.recheck, signal, () => getAgent(engine, agent.engineAgentId))
        if (Object.keys(patch).length) detail = await externalMcpGuarded(context, deps.recheck, signal, () => patchAgent(engine, agent.engineAgentId, patch as never))
        const latest = await externalMcpOwnedAgent(db, context, deps.recheck, signal, agentId)
        return {
            ...publicAgent(latest),
            handle: detail.config.name,
            soul: detail.soul,
            runsOn: { connectionId: detail.config.connectionId ?? null, provider: detail.config.provider ?? null, model: detail.config.model ?? null },
        }
    }

    if (tool === 'delete_agent') {
        requireConfirm(args, 'permanently delete this coworker and its local data')
        const agentId = requireString(args.agentId, 'agentId')
        const agent = await externalMcpOwnedAgent(db, context, deps.recheck, signal, agentId)
        await externalMcpGuarded(context, deps.recheck, signal, () => deleteDesktopCoworker(db, engine, agent.id, agent.name))
        return { agentId: agent.id, deleted: true }
    }

    if (tool === 'list_ai_connections') {
        const providers = await externalMcpGuarded(context, deps.recheck, signal, () => readDesktopProviders(runtime))
        return {
            default: providers.default ? {
                connectionId: providers.default.connectionId,
                model: providers.default.model,
                connectionName: providers.connections.find(connection => connection.id === providers.default?.connectionId)?.name ?? null,
            } : null,
            connections: providers.connections.map(connection => ({
                id: connection.id,
                name: connection.name,
                provider: connection.provider,
                models: [...connection.models, ...connection.extraModels],
                connected: connection.connected,
                isDefault: providers.default?.connectionId === connection.id,
            })),
        }
    }

    if (tool === 'set_default_model') {
        const connectionId = requireString(args.connectionId, 'connectionId')
        const model = requireString(args.model, 'model')
        await externalMcpGuarded(context, deps.recheck, signal, () => changeDesktopSettings(runtime, { action: 'default', connectionId, model }))
        const providers = await readDesktopProviders(runtime)
        return {
            default: providers.default ? {
                connectionId: providers.default.connectionId,
                model: providers.default.model,
                connectionName: providers.connections.find(connection => connection.id === providers.default?.connectionId)?.name ?? null,
            } : null,
        }
    }

    if (tool === 'list_skills' || tool === 'get_skill' || tool === 'read_skill_file' || tool === 'upsert_skill' || tool === 'delete_skill') {
        const agentId = requireString(args.agentId, 'agentId')
        const agent = await externalMcpOwnedAgent(db, context, deps.recheck, signal, agentId)
        if (tool === 'list_skills') {
            const skills = await externalMcpGuarded(context, deps.recheck, signal, () => listCoworkerSkills(runtime, agent.id))
            if (skills.length > 200) throw new Error('Too many skills for one external response.')
            return { skills: skills.map(skill => ({ slug: skill.slug, name: skill.name, description: skill.description })) }
        }
        if (tool === 'get_skill') {
            const skill = await externalMcpGuarded(context, deps.recheck, signal, () => getCoworkerSkill(runtime, agent.id, requireString(args.slug, 'slug')))
            if (!skill) throw new Error('Skill not found.')
            return { slug: skill.slug, name: skill.name, description: skill.description, body: skill.body, files: skill.files, identity: (skill as { identity?: string }).identity ?? null }
        }
        if (tool === 'read_skill_file') {
            const parsed = z.strictObject({ agentId: id, slug: id, path: z.string().min(1).max(1024), offset: z.literal(0).optional() }).parse(args)
            const file = await externalMcpGuarded(context, deps.recheck, signal, () => readCoworkerSkillFile(runtime, agent.id, parsed.slug, parsed.path))
            if (!file) throw new Error('Skill file not found.')
            return { slug: parsed.slug, ...file }
        }
        if (tool === 'delete_skill') {
            requireConfirm(args, 'delete this skill and its reference files')
            const slug = requireString(args.slug, 'slug')
            const result = await externalMcpGuarded(context, deps.recheck, signal, () => deleteCoworkerSkill(runtime, agent.id, slug))
            if (!result.success) throw new Error(result.error ?? 'Skill delete failed.')
            return { slug, deleted: true }
        }
        // upsert_skill
        const name = requireString(args.name, 'name')
        const description = asString(args.description) ?? ''
        const body = asString(args.body) ?? ''
        const slugHint = asString(args.slug)
        const existing = slugHint ? await getCoworkerSkill(runtime, agent.id, slugHint) : null
        if (!existing) {
            if (!body.trim()) throw new Error('Skill body is required to create a skill.')
            const created = await externalMcpGuarded(context, deps.recheck, signal, () => createCoworkerSkill(runtime, agent.id, { name, description, body }))
            if (!created.success || !created.skill) throw new Error(created.error ?? 'Skill create failed.')
            const files = Array.isArray(args.files) ? args.files : []
            for (const file of files) {
                if (!file || typeof file !== 'object') continue
                const path = requireString((file as { path?: unknown }).path, 'files.path')
                const content = requireString((file as { content?: unknown }).content, 'files.content')
                const written = await writeCoworkerSkillFile(runtime, agent.id, created.skill.slug, path, content)
                if (!written.success) throw new Error(written.error ?? 'Skill file write failed.')
            }
            return { skill: created.skill, created: true }
        }
        const identity = typeof (existing as { identity?: unknown }).identity === 'string' ? (existing as { identity: string }).identity : ''
        if (!identity) throw new Error('Reopen this skill before saving; identity revision is missing.')
        const updated = await externalMcpGuarded(context, deps.recheck, signal, () => updateCoworkerSkill(runtime, agent.id, existing.slug, {
            description: asString(args.description),
            body: asString(args.body),
            baseIdentity: identity,
        }))
        if (!updated.success || !updated.skill) throw new Error(updated.error ?? 'Skill update failed.')
        return { skill: updated.skill, created: false }
    }

    if (tool === 'list_schedules' || tool === 'upsert_schedule' || tool === 'run_schedule_now' || tool === 'delete_schedule') {
        const agentId = requireString(args.agentId, 'agentId')
        const agent = await externalMcpOwnedAgent(db, context, deps.recheck, signal, agentId)
        await externalMcpGuarded(context, deps.recheck, signal, () => authorizeDesktopSchedules(runtime, db, agent.engineAgentId, signal))
        if (tool === 'list_schedules') {
            const schedules = await listSchedules(engine, agent.engineAgentId)
            return { schedules }
        }
        if (tool === 'delete_schedule') {
            requireConfirm(args, 'delete this scheduled task')
            const slug = requireString(args.slug, 'slug')
            await externalMcpGuarded(context, deps.recheck, signal, () => deleteSchedule(engine, agent.engineAgentId, slug))
            return { slug, deleted: true }
        }
        if (tool === 'run_schedule_now') {
            const slug = requireString(args.slug, 'slug')
            const response = await externalMcpGuarded(context, deps.recheck, signal, () => fetch(`${engine.baseUrl}/agents/${encodeURIComponent(agent.engineAgentId)}/schedules/${encodeURIComponent(slug)}/run`, {
                method: 'POST',
                headers: { Authorization: `Bearer ${engine.apiKey}`, 'x-desktop-schedule-request-id': context.requestId },
                signal: AbortSignal.any([signal, AbortSignal.timeout(120_000)]),
            }))
            if (!response.ok) throw new Error('Task could not start.')
            const ids = z.object({ sessionId: z.string(), runId: z.string() }).parse(await response.json())
            return ids
        }
        const slug = asString(args.slug)
        const input = {
            name: asString(args.name) ?? (slug ? undefined : requireString(args.name, 'name')),
            description: asString(args.description) ?? '',
            body: asString(args.body),
            cron: asString(args.cron) ?? null,
            runAt: asString(args.runAt) ?? null,
            timezone: asString(args.timezone) ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
            enabled: typeof args.enabled === 'boolean' ? args.enabled : true,
            connectionId: null as string | null,
            provider: null as null,
            model: null as string | null,
        }
        if (!slug) {
            if (!input.name || !input.body) throw new Error('name and body are required to create a schedule.')
            const created = await externalMcpGuarded(context, deps.recheck, signal, () => createSchedule(engine, agent.engineAgentId, {
                name: input.name!,
                description: input.description,
                body: input.body!,
                cron: input.cron ?? undefined,
                runAt: input.runAt ?? undefined,
                timezone: input.timezone,
                enabled: input.enabled,
                connectionId: null,
                provider: null,
                model: null,
            }))
            return { schedule: created, created: true }
        }
        const patch: Record<string, unknown> = {}
        if (input.name !== undefined) patch.name = input.name
        if (asString(args.description) !== undefined) patch.description = input.description
        if (input.body !== undefined) patch.body = input.body
        if (asString(args.cron) !== undefined) patch.cron = input.cron
        if (asString(args.runAt) !== undefined) patch.runAt = input.runAt
        if (asString(args.timezone) !== undefined) patch.timezone = input.timezone
        if (typeof args.enabled === 'boolean') patch.enabled = input.enabled
        patch.connectionId = null
        patch.provider = null
        patch.model = null
        const updated = await externalMcpGuarded(context, deps.recheck, signal, () => updateSchedule(engine, agent.engineAgentId, slug, patch as never))
        return { schedule: updated, created: false }
    }

    if (tool === 'list_triggers' || tool === 'upsert_trigger' || tool === 'test_trigger' || tool === 'rotate_trigger_token' || tool === 'delete_trigger') {
        const agentId = requireString(args.agentId, 'agentId')
        const agent = await externalMcpOwnedAgent(db, context, deps.recheck, signal, agentId)
        await externalMcpGuarded(context, deps.recheck, signal, () => authorizeDesktopTriggers(runtime, db, agent.engineAgentId, signal))
        const base = { localAgentId: agent.id, engineAgentId: agent.engineAgentId }
        if (tool === 'list_triggers') {
            const listed = await externalMcpGuarded(context, deps.recheck, signal, () => desktopTriggerEngine(runtime, { op: 'list', ...base }, signal)) as { triggers?: any[] }
            const triggers = (listed?.triggers ?? []).map(row => {
                const { token, ...rest } = row ?? {}
                return rest
            })
            return { triggers }
        }
        if (tool === 'delete_trigger') {
            requireConfirm(args, 'delete this webhook trigger')
            const slug = requireString(args.slug, 'slug')
            await externalMcpGuarded(context, deps.recheck, signal, () => desktopTriggerEngine(runtime, { op: 'delete', ...base, slug, input: { requestId: context.requestId } }, signal))
            return { slug, deleted: true }
        }
        if (tool === 'rotate_trigger_token') {
            const slug = requireString(args.slug, 'slug')
            const result = await externalMcpGuarded(context, deps.recheck, signal, () => desktopTriggerEngine(runtime, { op: 'rotate', ...base, slug, input: { requestId: context.requestId } }, signal))
            return result
        }
        if (tool === 'test_trigger') {
            const slug = requireString(args.slug, 'slug')
            const current = await externalMcpGuarded(context, deps.recheck, signal, () => desktopTriggerEngine(runtime, { op: 'get', ...base, slug }, signal)) as { token?: string; methods?: string[]; enabled?: boolean }
            if (!current?.token) throw new Error('Trigger token is unavailable.')
            if (current.enabled === false) throw new Error('Enable the trigger before testing it.')
            const method = (asString(args.method) ?? current.methods?.[0] ?? 'POST').toUpperCase()
            const bodyValue = args.body
            const body = typeof bodyValue === 'string' ? bodyValue : bodyValue === undefined ? '' : JSON.stringify(bodyValue)
            const contentType = asString(args.contentType) ?? (typeof bodyValue === 'object' ? 'application/json' : '')
            const fire = {
                token: current.token,
                method,
                query: asString(args.query) ?? '',
                contentType,
                body,
                bodyBytes: Buffer.byteLength(body, 'utf8'),
                attemptFingerprint: context.requestId,
            }
            return await externalMcpGuarded(context, deps.recheck, signal, () => desktopTriggerEngine(runtime, { op: 'fire', ...base, slug, input: fire }, signal))
        }
        const slug = asString(args.slug)
        const input: Record<string, unknown> = {
            requestId: context.requestId,
            name: asString(args.name),
            description: asString(args.description),
            body: asString(args.body),
            methods: Array.isArray(args.methods) ? args.methods : undefined,
            enabled: typeof args.enabled === 'boolean' ? args.enabled : undefined,
            connectionId: null,
            provider: null,
            model: null,
        }
        if (!slug) {
            if (!input.name || !input.body) throw new Error('name and body are required to create a trigger.')
            const created = await externalMcpGuarded(context, deps.recheck, signal, () => desktopTriggerEngine(runtime, { op: 'create', ...base, input }, signal))
            return { trigger: created, created: true }
        }
        const updated = await externalMcpGuarded(context, deps.recheck, signal, () => desktopTriggerEngine(runtime, { op: 'update', ...base, slug, input }, signal))
        return { trigger: updated, created: false }
    }

    if (tool === 'send_message') {
        const agentId = requireString(args.agentId, 'agentId')
        const message = requireString(args.message, 'message')
        const agent = await externalMcpOwnedAgent(db, context, deps.recheck, signal, agentId)
        const sessionId = asString(args.sessionId)
        const waitSeconds = typeof args.waitSeconds === 'number' ? args.waitSeconds : 120
        const started = await externalMcpGuarded(context, deps.recheck, signal, () => startDesktopChat(runtime, {
            agentId: agent.id,
            text: message,
            ...(sessionId ? { sessionId } : {}),
            requestId: context.requestId,
        }))
        const runId = started.response.headers.get('x-run-id')
        await drain(started.response)
        if (!runId) return { status: 'uncertain', sessionId: started.sessionId, message: 'Chat was accepted but no run id was returned.' }
        const run = await waitRun(engine, agent.engineAgentId, runId, waitSeconds, context, deps, signal)
        return { status: run.status, runId: run.id, sessionId: started.sessionId, run: desktopRunView(run) }
    }

    if (tool === 'list_runs') {
        const parsed = z.strictObject({ agentId: id, limit: z.number().int().min(1).max(200).optional() }).parse(args)
        const agent = await externalMcpOwnedAgent(db, context, deps.recheck, signal, parsed.agentId)
        const runs = await externalMcpGuarded(context, deps.recheck, signal, () => listRuns(engine, agent.engineAgentId, { limit: parsed.limit ?? 20 }, { signal }))
        if (runs.some(run => run.agentId !== agent.engineAgentId)) throw new Error('Run identity mismatch.')
        return { runs: runs.map(desktopRunView) }
    }

    if (tool === 'get_run') {
        const agentId = requireString(args.agentId, 'agentId')
        const runId = requireString(args.runId, 'runId')
        const agent = await externalMcpOwnedAgent(db, context, deps.recheck, signal, agentId)
        const run = await externalMcpGuarded(context, deps.recheck, signal, () => getRun(engine, agent.engineAgentId, runId, { signal }))
        if (run.agentId !== agent.engineAgentId || run.id !== runId) throw new Error('Run identity mismatch.')
        let toolCalls: unknown[] | undefined
        try {
            const tools = await getRunTools(engine, agent.engineAgentId, runId)
            if (tools.length > 50) throw new Error('Too many tool calls to include.')
            toolCalls = tools
        } catch { toolCalls = undefined }
        return { run: desktopRunView(run), ...(toolCalls ? { toolCalls } : {}) }
    }

    if (tool === 'list_tables' || tool === 'db_query' || tool === 'db_execute') {
        const agentId = requireString(args.agentId, 'agentId')
        const agent = await externalMcpOwnedAgent(db, context, deps.recheck, signal, agentId)
        const base = agentDataBase(agent.engineAgentId)
        if (tool === 'list_tables') {
            const tables = await externalMcpGuarded(context, deps.recheck, signal, () => listDbTables(engine, base))
            return { tables: tables.filter(table => !/^(?:_rerun_|sqlite_)/i.test(table.name)) }
        }
        if (tool === 'db_query') {
            const sql = requireString(args.sql, 'sql')
            const limit = typeof args.limit === 'number' ? Math.min(Math.max(Math.trunc(args.limit), 1), 1000) : 100
            return await externalMcpGuarded(context, deps.recheck, signal, () => queryDb(engine, base, { sql, params: Array.isArray(args.params) ? args.params : undefined, limit }))
        }
        const sql = asString(args.sql)
        const statements = Array.isArray(args.statements) ? args.statements : undefined
        if (!sql && !statements) throw new Error('Provide sql or statements.')
        return await externalMcpGuarded(context, deps.recheck, signal, () => executeDb(engine, base, { sql, params: Array.isArray(args.params) ? args.params : undefined, statements: statements as never }))
    }

    if (tool === 'list_space_tables' || tool === 'space_db_query' || tool === 'space_db_execute') {
        const spaceId = requireString(args.spaceId, 'spaceId')
        const board = await externalMcpGuarded(context, deps.recheck, signal, () => readDesktopBoardState(db))
        if (!board.spaces.some(space => space.id === spaceId)) throw new Error('Box not found.')
        const base = SPACE_DATA_BASE
        if (tool === 'list_space_tables') {
            const tables = await externalMcpGuarded(context, deps.recheck, signal, () => listDbTables(engine, base))
            return { tables: tables.filter(table => !/^(?:_rerun_|sqlite_)/i.test(table.name)) }
        }
        if (tool === 'space_db_query') {
            const sql = requireString(args.sql, 'sql')
            const limit = typeof args.limit === 'number' ? Math.min(Math.max(Math.trunc(args.limit), 1), 1000) : 100
            return await externalMcpGuarded(context, deps.recheck, signal, () => queryDb(engine, base, { sql, params: Array.isArray(args.params) ? args.params : undefined, limit }))
        }
        const sql = asString(args.sql)
        const statements = Array.isArray(args.statements) ? args.statements : undefined
        if (!sql && !statements) throw new Error('Provide sql or statements.')
        return await externalMcpGuarded(context, deps.recheck, signal, () => executeDb(engine, base, { sql, params: Array.isArray(args.params) ? args.params : undefined, statements: statements as never }))
    }

    if (tool === 'search_connectors' || tool === 'list_connectors') {
        const query = asString(args.query)
        const category = asString(args.category)
        const offset = typeof args.offset === 'number' ? Math.max(Math.trunc(args.offset), 0) : 0
        const limit = typeof args.limit === 'number' ? Math.min(Math.max(Math.trunc(args.limit), 1), 200) : 60
        const page = await externalMcpGuarded(context, deps.recheck, signal, () => listDesktopServiceCatalog({ query, category, offset, limit }))
        return {
            total: page.total,
            offset,
            connectors: page.services.map(service => ({
                slug: service.slug,
                name: service.name,
                category: service.category,
                summary: service.summary,
            })),
        }
    }

    if (tool === 'list_agent_connectors' || tool === 'attach_connector' || tool === 'detach_connector') {
        if (!deps.services) throw new Error('Local service authority is not bound for external connector mutations/reads.')
        const agentId = requireString(args.agentId, 'agentId')
        const agent = await externalMcpOwnedAgent(db, context, deps.recheck, signal, agentId)
        if (tool === 'list_agent_connectors') {
            const connectors = await externalMcpGuarded(context, deps.recheck, signal, () => deps.services!.listInstalled(agent.id, signal))
            return { connectors }
        }
        if (tool === 'attach_connector') {
            const slug = requireString(args.slug, 'slug')
            const authMethodId = asString(args.authMethodId)
            if (!authMethodId) throw new Error('attach_connector requires authMethodId for the local service install authority.')
            const values = args.values && typeof args.values === 'object' && !Array.isArray(args.values) ? args.values as Record<string, string> : {}
            const result = await externalMcpGuarded(context, deps.recheck, signal, () => deps.services!.mutate(agent.id, {
                action: 'install',
                requestId: context.requestId,
                slug,
                authMethodId,
                values,
            }, signal))
            return result
        }
        requireConfirm(args, 'detach this connector and its credentials')
        const key = asString(args.key) ?? asString(args.slug)
        if (!key) throw new Error('Pass key or slug.')
        const installed = await deps.services.listInstalled(agent.id, signal)
        const match = installed.find(row => row.key === key || row.slug === key)
        if (!match) throw new Error('Connector not found.')
        const result = await externalMcpGuarded(context, deps.recheck, signal, () => deps.services!.mutate(agent.id, {
            action: 'remove',
            requestId: context.requestId,
            key: match.key,
            expectedRevision: match.revision,
        }, signal))
        return { key: match.key, detached: true, result }
    }

    throw new Error(`Unsupported external tool: ${tool}`)
}

export function externalMcpOperationError(error: unknown): Error {
    return new Error(messageOf(error))
}

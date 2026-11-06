import { createHash } from 'node:crypto'
import { tool, type ToolSet } from 'ai'
import { z } from 'zod'
import { providerSchema, DESKTOP_SCHEDULE_TOOL_MESSAGES as M, type DesktopScheduleToolProjection } from '@rerun/contracts'
import type { DesktopScheduleLifecycle } from './lifecycle.js'
import { DesktopScheduleToolError } from './lifecycle.js'
import { beginDesktopAgentWork } from '../agent-lifecycle.js'
import type { DesktopScheduleIntentStore, DesktopScheduleToolAuthority, DesktopScheduleToolContext } from './types.js'

const slug = z.string().trim().regex(/^[A-Za-z0-9_-]{1,160}$/)

function requestId(engineAgentId: string, runId: string, toolCallId: string): string {
    const hex = createHash('sha256').update(`${engineAgentId}:${runId}:${toolCallId}`).digest('hex')
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}

export function createDesktopScheduleToolFactory(deps: {
    authority: DesktopScheduleToolAuthority
    lifecycle: DesktopScheduleLifecycle
    store: DesktopScheduleIntentStore
}) {
    const projections = new Map<string, DesktopScheduleToolProjection>()
    function finish(key: string, operation: DesktopScheduleToolProjection['operation'], slugValue: string | null, outcome: DesktopScheduleToolProjection['outcome'], text: string, revision: string | null) {
        const projection = { outcome, operation, text, slug: slugValue, revision }
        projections.set(key, projection)
        return text
    }
    return {
        projection(engineAgentId: string, runId: string, key: string) { return projections.get(JSON.stringify([engineAgentId, runId, key])) ?? null },
        tools(engineAgentId: string, context?: DesktopScheduleToolContext): ToolSet {
            const guard = async () => {
                deps.authority.assertActive()
                if (context?.abortSignal?.aborted) throw new DesktopScheduleToolError('cancelled', M.cancelled)
                if (!context?.runId || !context.sessionId) throw new DesktopScheduleToolError('rejected', M.inactive)
                const run = await deps.authority.readRun(engineAgentId, context.runId)
                if (!run || run.agentId !== engineAgentId || run.sessionId !== context.sessionId || run.status !== 'running') throw new DesktopScheduleToolError('rejected', M.inactive)
                const owner = await deps.authority.resolveOwner(engineAgentId)
                if (owner.engineAgentId !== engineAgentId || owner.deleting) throw new DesktopScheduleToolError('rejected', M.deleting)
                if (!owner.enabled) throw new DesktopScheduleToolError('rejected', M.disabled)
                if (owner.setupPending) throw new DesktopScheduleToolError('rejected', M.setup)
                if (!owner.scheduleManage) throw new DesktopScheduleToolError('rejected', M.permission)
                if (context.abortSignal?.aborted) throw new DesktopScheduleToolError('cancelled', M.cancelled)
                deps.authority.assertActive()
            }
            const idFor = (options?: { toolCallId?: string }) => {
                if (!context?.runId || !options?.toolCallId) throw new DesktopScheduleToolError('rejected', M.invocation)
                return requestId(engineAgentId, context.runId, options.toolCallId)
            }
            const run = async (key: string, operation: DesktopScheduleToolProjection['operation'], slugValue: string | null, work: () => Promise<{ text: string; revision: string | null; outcome?: DesktopScheduleToolProjection['outcome'] }>) => {
                key = JSON.stringify([engineAgentId, context?.runId, key])
                const release = beginDesktopAgentWork(engineAgentId)
                try {
                    const result = await work()
                    return finish(key, operation, slugValue, result.outcome ?? 'committed', result.text, result.revision)
                } catch (error) {
                    if (context?.abortSignal?.aborted) return finish(key, operation, slugValue, 'cancelled', M.cancelled, null)
                    if (error instanceof DesktopScheduleToolError) return finish(key, operation, slugValue, error.outcome, error.message, null)
                    if (error instanceof Error && error.message === M.fileUnsafe) return finish(key, operation, slugValue, 'rejected', error.message, null)
                    return finish(key, operation, slugValue, 'uncertain', M.uncertain, null)
                } finally { release() }
            }
            return {
                schedule_list: tool({
                    description: 'List your scheduled tasks (recurring cron jobs and one-shot reminders). Instruction bodies are not included here; read one in full with schedule_get. Listing does not run a task.',
                    inputSchema: z.object({}),
                    execute: async (_input, options) => run(options?.toolCallId ?? 'list', 'list', null, async () => {
                        await guard()
                        const receipt = await deps.lifecycle.list(engineAgentId, guard)
                        return { text: receipt.text, revision: null }
                    }),
                }),
                schedule_get: tool({
                    description: 'Read one scheduled task in full, including the instruction body it runs when it fires and its definition revision. Always call this before changing a body. Reading does not run the task.',
                    inputSchema: z.object({ slug }),
                    execute: async ({ slug: task }, options) => run(options?.toolCallId ?? `get:${task}`, 'get', task, async () => {
                        await guard()
                        const receipt = await deps.lifecycle.get(engineAgentId, task, guard)
                        return { text: receipt.text, revision: receipt.revision }
                    }),
                }),
                schedule_create: tool({
                    description: 'Schedule a task to run later without a user message. Provide a cron expression for a recurring task OR runAt (ISO 8601) for a one-shot, plus an IANA timezone. The body is the instruction you will execute when it fires. Creating does not run the task. Natural-language times are refused. On this Mac the task follows the coworker’s connected model.',
                    inputSchema: z.object({
                        name: z.string().trim().min(1).max(120),
                        description: z.string().trim().max(4000).default(''),
                        body: z.string().trim().min(1).max(64000),
                        cron: z.string().trim().min(1).max(120).optional().describe("Cron expression, e.g. '0 8 * * *'"),
                        runAt: z.string().trim().min(1).max(80).optional().describe('ISO 8601 timestamp for a one-shot task'),
                        timezone: z.string().trim().min(1).max(100).optional().describe("IANA timezone, e.g. 'Europe/Paris'"),
                        provider: providerSchema.optional().describe('Model provider to run this task under. Only with a model, and only when it is this coworker’s connected model.'),
                        model: z.string().trim().min(1).max(200).optional().describe('Model id. Only if the user asks for one, and only when it is this coworker’s connected model. Otherwise the task follows the coworker.'),
                    }),
                    execute: async (input, options) => {
                        const key = options?.toolCallId ?? 'create'
                        return run(key, 'create', null, async () => {
                            await guard()
                            const receipt = await deps.lifecycle.create(engineAgentId, { requestId: idFor(options), ...input }, guard)
                            return { text: receipt.text, revision: receipt.revision }
                        })
                    },
                }),
                schedule_update: tool({
                    description: 'Update an existing scheduled task (description, cron, runAt, timezone, or enable/disable it). Passing body overwrites the entire instruction body: use it ONLY for a deliberate full rewrite of a body you have just read with schedule_get. For ANY partial change to the body, use schedule_edit instead. Pass expectedRevision from schedule_get. A stale revision is rejected and the previous routine is kept. Setting cron clears runAt, and setting runAt clears cron. This does not run the task.',
                    inputSchema: z.object({
                        slug,
                        expectedRevision: z.string().regex(/^[a-f0-9]{64}$/),
                        description: z.string().trim().max(4000).optional(),
                        body: z.string().max(64000).optional(),
                        cron: z.string().trim().min(1).max(120).optional(),
                        runAt: z.string().trim().min(1).max(80).optional(),
                        timezone: z.string().trim().min(1).max(100).optional(),
                        enabled: z.boolean().optional(),
                        provider: providerSchema.optional().describe('Model provider. Only together with a model, and only this coworker’s connected model.'),
                        model: z.string().trim().min(1).max(200).optional().describe('Model id. Only if the user asks for one, and only this coworker’s connected model.'),
                    }),
                    execute: async (input, options) => run(options?.toolCallId ?? `update:${input.slug}`, 'update', input.slug, async () => {
                        await guard()
                        const requestId = idFor(options)
                        const expectedRevision = input.expectedRevision
                        if (!expectedRevision) throw new DesktopScheduleToolError('rejected', M.stale)
                        const receipt = await deps.lifecycle.update(engineAgentId, input.slug, {
                            requestId,
                            expectedRevision,
                            description: input.description,
                            body: input.body,
                            cron: input.cron,
                            runAt: input.runAt,
                            timezone: input.timezone,
                            enabled: input.enabled,
                            provider: input.provider,
                            model: input.model,
                        }, guard)
                        return { text: receipt.text, revision: receipt.revision }
                    }),
                }),
                schedule_edit: tool({
                    description: 'Make a surgical edit to a scheduled task body by replacing an exact string — this is the default way to change a body and it preserves everything else. Read the body with schedule_get first so oldString is an exact excerpt. Prefer this over schedule_update for any partial change. By default oldString must match exactly once. Pass expectedRevision from schedule_get. A stale or ambiguous replacement is rejected and the previous routine is kept. This does not run the task.',
                    inputSchema: z.object({
                        slug,
                        expectedRevision: z.string().regex(/^[a-f0-9]{64}$/),
                        oldString: z.string().min(1),
                        newString: z.string(),
                        replaceAll: z.boolean().default(false).describe('Replace every occurrence instead of requiring a unique match'),
                    }),
                    execute: async (input, options) => run(options?.toolCallId ?? `edit:${input.slug}`, 'edit', input.slug, async () => {
                        await guard()
                        const requestId = idFor(options)
                        const expectedRevision = input.expectedRevision
                        if (!expectedRevision) throw new DesktopScheduleToolError('rejected', M.stale)
                        const receipt = await deps.lifecycle.edit(engineAgentId, input.slug, { requestId, expectedRevision, oldString: input.oldString, newString: input.newString, replaceAll: input.replaceAll }, guard)
                        return { text: receipt.text, revision: receipt.revision }
                    }),
                }),
                schedule_delete: tool({
                    description: 'Delete a scheduled task definition. Run history is kept. This does not run the task or delete past results.',
                    inputSchema: z.object({ slug, expectedRevision: z.string().regex(/^[a-f0-9]{64}$/) }),
                    execute: async ({ slug: task, expectedRevision }, options) => run(options?.toolCallId ?? `delete:${task}`, 'delete', task, async () => {
                        await guard()
                        const requestId = idFor(options)
                        const revision = expectedRevision
                        if (!revision) throw new DesktopScheduleToolError('rejected', M.stale)
                        const receipt = await deps.lifecycle.remove(engineAgentId, task, { requestId, expectedRevision: revision }, guard)
                        return { text: receipt.text, revision: receipt.revision }
                    }),
                }),
            }
        },
    }
}

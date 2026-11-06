import { createHash } from 'node:crypto'
import { tool, type ToolSet } from 'ai'
import { z } from 'zod'
import {
    DESKTOP_TRIGGER_TOOL_DESCRIPTIONS as D,
    DESKTOP_TRIGGER_TOOL_MAX_BODY_CHARS,
    DESKTOP_TRIGGER_TOOL_MESSAGES as M,
    desktopTriggerRotateConfirmationSchema,
    providerSchema,
    triggerMethodSchema,
    type DesktopTriggerCreate,
    type DesktopTriggerToolProjection,
    type DesktopTriggerUpdate,
} from '@rerun/contracts'
import { desktopTriggerDefinitionRevision } from '../triggers/lifecycle.js'
import type { DesktopTriggerLifecycle } from '../triggers/lifecycle.js'
import type { DesktopTriggerStore } from '../triggers/types.js'
import { DesktopTriggerToolError, mapTriggerToolError } from './errors.js'
import { desktopTriggerModelDecision } from './model.js'
import { projectTriggerGet, projectTriggerList, scrubTriggerToolText } from './project.js'
import type { DesktopTriggerToolAuthority, DesktopTriggerToolContext } from './types.js'

const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'])

function requestIdFor(engineAgentId: string, runId: string, toolCallId: string): string {
    const hex = createHash('sha256').update(`${engineAgentId}:${runId}:${toolCallId}`).digest('hex')
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}

function occurrences(body: string, excerpt: string): number {
    if (!excerpt) return 0
    return body.split(excerpt).length - 1
}

function replaceExcerpt(body: string, excerpt: string, next: string, replaceAll: boolean): string {
    return replaceAll ? body.split(excerpt).join(next) : body.replace(excerpt, next)
}

function bodyProblem(body: string | undefined): string | null {
    if (body === undefined) return null
    if (body.length > DESKTOP_TRIGGER_TOOL_MAX_BODY_CHARS) return M.tooLong
    if (body.trim().length === 0) return M.emptyBody
    return null
}

function methodsProblem(methods: readonly string[] | undefined): string | null {
    if (!methods) return null
    if (methods.length < 1 || methods.some(method => !METHODS.has(method))) return M.methods
    return null
}

function asMethods(methods: readonly string[] | undefined): DesktopTriggerCreate['methods'] {
    return (methods && methods.length > 0 ? [...methods] : ['POST']) as DesktopTriggerCreate['methods']
}

export function createDesktopTriggerToolFactory(deps: {
    authority: DesktopTriggerToolAuthority
    lifecycle: DesktopTriggerLifecycle
    store: DesktopTriggerStore
}) {
    const projections = new Map<string, DesktopTriggerToolProjection>()
    function finish(key: string, operation: DesktopTriggerToolProjection['operation'], slugValue: string | null, outcome: DesktopTriggerToolProjection['outcome'], text: string, revision: string | null): string {
        const safe = scrubTriggerToolText(text)
        projections.set(key, { outcome, operation, text: safe, slug: slugValue, revision })
        return safe
    }
    return {
        projection(key: string) { return projections.get(key) ?? null },
        tools(engineAgentId: string, context?: DesktopTriggerToolContext): ToolSet {
            const guard = async () => {
                try { deps.authority.assertActive() } catch { throw new DesktopTriggerToolError('rejected', M.inactive) }
                if (context?.abortSignal?.aborted) throw new DesktopTriggerToolError('cancelled', M.cancelled)
                if (!context?.runId || !context.sessionId) throw new DesktopTriggerToolError('rejected', M.inactive)
                const run = await deps.authority.readRun(engineAgentId, context.runId)
                if (!run || run.agentId !== engineAgentId || run.sessionId !== context.sessionId || run.status !== 'running') throw new DesktopTriggerToolError('rejected', M.inactive)
                const owner = await deps.authority.resolveOwner(engineAgentId)
                if (owner.engineAgentId !== engineAgentId || owner.deleting) throw new DesktopTriggerToolError('rejected', M.deleting)
                if (!owner.enabled) throw new DesktopTriggerToolError('rejected', M.disabled)
                try { await deps.authority.assertSetupClear(engineAgentId) } catch { throw new DesktopTriggerToolError('rejected', M.setup) }
                try { await deps.authority.assertTriggerGrant(engineAgentId) } catch { throw new DesktopTriggerToolError('rejected', M.permission) }
                if (context.abortSignal?.aborted) throw new DesktopTriggerToolError('cancelled', M.cancelled)
                try { deps.authority.assertActive() } catch { throw new DesktopTriggerToolError('rejected', M.inactive) }
            }
            const idFor = (options?: { toolCallId?: string }) => {
                if (!context?.runId || !options?.toolCallId) throw new DesktopTriggerToolError('rejected', M.invocation)
                return requestIdFor(engineAgentId, context.runId, options.toolCallId)
            }
            const run = async (key: string, operation: DesktopTriggerToolProjection['operation'], slugValue: string | null, work: () => Promise<{ text: string; revision: string | null; outcome?: DesktopTriggerToolProjection['outcome']; slug?: string | null }>) => {
                try {
                    const result = await work()
                    return finish(key, operation, result.slug === undefined ? slugValue : result.slug, result.outcome ?? 'committed', result.text, result.revision)
                } catch (error) {
                    if (context?.abortSignal?.aborted) return finish(key, operation, slugValue, 'cancelled', M.cancelled, null)
                    const mapped = mapTriggerToolError(error, slugValue)
                    return finish(key, operation, slugValue, mapped.outcome, mapped.message, null)
                }
            }
            const pinsFor = async (provider: string | undefined, model: string | undefined, loneProvider: 'ignore' | 'refuse') => {
                if (model) {
                    let connected: { provider: string; model: string } | null = null
                    try { connected = await deps.authority.connectedModel(engineAgentId) } catch { connected = null }
                    return desktopTriggerModelDecision({ provider, model, connected, loneProvider })
                }
                return desktopTriggerModelDecision({ provider, model, connected: null, loneProvider })
            }
            return {
                trigger_list: tool({
                    description: D.trigger_list,
                    inputSchema: z.object({}),
                    execute: async (_input, options) => run(options?.toolCallId ?? 'list', 'list', null, async () => {
                        await guard()
                        const triggers = await deps.lifecycle.list(engineAgentId)
                        return { text: projectTriggerList(triggers), revision: null }
                    }),
                }),
                trigger_get: tool({
                    description: D.trigger_get,
                    inputSchema: z.object({ slug: z.string() }),
                    execute: async ({ slug }, options) => run(options?.toolCallId ?? `get:${slug}`, 'get', slug, async () => {
                        await guard()
                        const trigger = await deps.lifecycle.get(engineAgentId, slug, { includeToken: false })
                        return { text: projectTriggerGet(trigger), revision: trigger.revision }
                    }),
                }),
                trigger_create: tool({
                    description: D.trigger_create,
                    inputSchema: z.object({
                        name: z.string(),
                        description: z.string().describe('One line describing what this trigger reacts to'),
                        body: z.string().describe('The instruction to run when the local address is called. The caller payload is appended to it.'),
                        methods: z.array(triggerMethodSchema).optional().describe('HTTP methods this local webhook accepts. Defaults to POST only. Adding GET means any link preview can fire it.'),
                        provider: providerSchema.optional().describe('Model provider. Only with a model, and only when it is this coworker’s connected model. A named pin is not stored.'),
                        model: z.string().optional().describe('Model id. Only if the user asks for one, and only when it is this coworker’s connected model. Otherwise the trigger follows the coworker.'),
                    }),
                    execute: async ({ name, description, body, methods, provider, model }, options) => run(options?.toolCallId ?? 'create', 'create', null, async () => {
                        await guard()
                        if (name.length < 1 || name.length > 120) throw new DesktopTriggerToolError('rejected', M.nameLength)
                        if (description.length > 4000) throw new DesktopTriggerToolError('rejected', M.descriptionLength)
                        const instruction = bodyProblem(body)
                        if (instruction) throw new DesktopTriggerToolError('rejected', instruction)
                        const methodError = methodsProblem(methods)
                        if (methodError) throw new DesktopTriggerToolError('rejected', methodError)
                        const requestId = idFor(options)
                        const prior = await deps.store.findIntent(engineAgentId, requestId)
                        if (!prior) {
                            const decision = await pinsFor(provider, model, 'ignore')
                            if (!decision.ok) throw new DesktopTriggerToolError('rejected', decision.refusal)
                        }
                        const input: DesktopTriggerCreate = {
                            requestId,
                            name,
                            description,
                            body,
                            methods: asMethods(methods),
                            connectionId: null,
                            provider: null,
                            model: null,
                        }
                        const created = await deps.lifecycle.create(engineAgentId, input, guard)
                        return { text: M.created(created.slug, created.methods.join('/')), revision: created.revision, slug: created.slug }
                    }),
                }),
                trigger_update: tool({
                    description: D.trigger_update,
                    inputSchema: z.object({
                        slug: z.string(),
                        expectedRevision: z.string().min(1).max(128).optional(),
                        description: z.string().optional(),
                        body: z.string().optional(),
                        methods: z.array(triggerMethodSchema).optional(),
                        enabled: z.boolean().optional(),
                        provider: providerSchema.optional().describe('Model provider. Only together with a model, and only this coworker’s connected model.'),
                        model: z.string().optional().describe('Model id. Only if the user asks for one, and only this coworker’s connected model.'),
                    }),
                    execute: async (input, options) => run(options?.toolCallId ?? `update:${input.slug}`, 'update', input.slug, async () => {
                        await guard()
                        if (input.description !== undefined && input.description.length > 4000) throw new DesktopTriggerToolError('rejected', M.descriptionLength)
                        const instruction = bodyProblem(input.body)
                        if (instruction) throw new DesktopTriggerToolError('rejected', instruction)
                        const methodError = methodsProblem(input.methods)
                        if (methodError) throw new DesktopTriggerToolError('rejected', methodError)
                        const requestId = idFor(options)
                        const prior = await deps.store.findIntent(engineAgentId, requestId)
                        let expectedRevision: string
                        let beforeBody = ''
                        if (prior?.before) {
                            expectedRevision = desktopTriggerDefinitionRevision(prior.before)
                            beforeBody = prior.before.body
                        } else {
                            const current = await deps.lifecycle.get(engineAgentId, input.slug, { includeToken: false })
                            if (input.expectedRevision && input.expectedRevision !== current.revision) throw new DesktopTriggerToolError('rejected', M.stale)
                            expectedRevision = input.expectedRevision ?? current.revision
                            beforeBody = current.body
                        }
                        let clearPins = false
                        if (!prior) {
                            const decision = await pinsFor(input.provider, input.model, 'refuse')
                            if (!decision.ok) throw new DesktopTriggerToolError('rejected', decision.refusal)
                            clearPins = decision.pins === 'clear'
                        } else if (input.model) clearPins = true
                        const raw: DesktopTriggerUpdate = { requestId, expectedRevision }
                        if (input.description !== undefined) raw.description = input.description
                        if (input.body !== undefined) raw.body = input.body
                        if (input.methods !== undefined) raw.methods = asMethods(input.methods)
                        if (input.enabled !== undefined) raw.enabled = input.enabled
                        if (clearPins) { raw.connectionId = null; raw.provider = null; raw.model = null }
                        const saved = await deps.lifecycle.update(engineAgentId, input.slug, raw, guard)
                        const text = input.body !== undefined && input.body !== beforeBody ? M.replacedBody(input.slug, beforeBody.length, input.body.length) : M.updated(input.slug)
                        return { text, revision: saved.revision }
                    }),
                }),
                trigger_edit: tool({
                    description: D.trigger_edit,
                    inputSchema: z.object({
                        slug: z.string(),
                        expectedRevision: z.string().min(1).max(128).optional(),
                        oldString: z.string().describe('The exact text to replace'),
                        newString: z.string().describe('The text to insert in its place'),
                        replaceAll: z.boolean().default(false).describe('Replace every occurrence instead of requiring a unique match'),
                    }),
                    execute: async (input, options) => run(options?.toolCallId ?? `edit:${input.slug}`, 'edit', input.slug, async () => {
                        await guard()
                        if (!input.oldString) throw new DesktopTriggerToolError('rejected', M.emptyExcerpt)
                        const requestId = idFor(options)
                        const prior = await deps.store.findIntent(engineAgentId, requestId)
                        const replaceAll = input.replaceAll === true
                        // The lifecycle stores this as kind `update`. The model text stays `Edited trigger…`.
                        if (prior?.before) {
                            const body = replaceExcerpt(prior.before.body, input.oldString, input.newString, replaceAll)
                            const saved = await deps.lifecycle.update(engineAgentId, input.slug, {
                                requestId,
                                expectedRevision: desktopTriggerDefinitionRevision(prior.before),
                                body,
                            }, guard)
                            return { text: M.edited(input.slug, occurrences(prior.before.body, input.oldString)), revision: saved.revision }
                        }
                        const current = await deps.lifecycle.get(engineAgentId, input.slug, { includeToken: false })
                        if (input.expectedRevision && input.expectedRevision !== current.revision) throw new DesktopTriggerToolError('rejected', M.stale)
                        if (input.oldString === input.newString) return { text: M.identical, revision: current.revision, outcome: 'rejected' }
                        const count = occurrences(current.body, input.oldString)
                        if (count === 0) throw new DesktopTriggerToolError('rejected', M.missingExcerpt(input.slug))
                        if (count > 1 && !replaceAll) throw new DesktopTriggerToolError('rejected', M.ambiguous(input.slug, count))
                        const body = replaceExcerpt(current.body, input.oldString, input.newString, replaceAll)
                        const instruction = bodyProblem(body)
                        if (instruction) throw new DesktopTriggerToolError('rejected', instruction)
                        const saved = await deps.lifecycle.update(engineAgentId, input.slug, {
                            requestId,
                            expectedRevision: current.revision,
                            body,
                        }, guard)
                        return { text: M.edited(input.slug, count), revision: saved.revision }
                    }),
                }),
                trigger_rotate_token: tool({
                    description: D.trigger_rotate_token,
                    inputSchema: z.object({
                        slug: z.string(),
                        confirmation: desktopTriggerRotateConfirmationSchema.optional().describe('Required. Copy slug and revision from trigger_get and set action to rotate.'),
                    }),
                    execute: async ({ slug, confirmation }, options) => run(options?.toolCallId ?? `rotate:${slug}`, 'rotate', slug, async () => {
                        await guard()
                        const requestId = idFor(options)
                        const prior = await deps.store.findIntent(engineAgentId, requestId)
                        let expectedRevision: string
                        if (prior?.before) expectedRevision = desktopTriggerDefinitionRevision(prior.before)
                        else {
                            const current = await deps.lifecycle.get(engineAgentId, slug, { includeToken: false })
                            const parsed = desktopTriggerRotateConfirmationSchema.safeParse(confirmation)
                            const bound = parsed.success && parsed.data.slug === slug && parsed.data.revision === current.revision
                            if (!bound) return { text: M.rotateConfirm, revision: current.revision, outcome: 'rejected' }
                            expectedRevision = current.revision
                        }
                        const rotated = await deps.lifecycle.rotate(engineAgentId, slug, { requestId, expectedRevision }, guard)
                        return { text: M.rotated(slug), revision: rotated.revision }
                    }),
                }),
                trigger_delete: tool({
                    description: D.trigger_delete,
                    inputSchema: z.object({
                        slug: z.string(),
                        expectedRevision: z.string().min(1).max(128).optional(),
                    }),
                    execute: async ({ slug, expectedRevision }, options) => run(options?.toolCallId ?? `delete:${slug}`, 'delete', slug, async () => {
                        await guard()
                        const requestId = idFor(options)
                        const prior = await deps.store.findIntent(engineAgentId, requestId)
                        const revision = prior?.before
                            ? desktopTriggerDefinitionRevision(prior.before)
                            : expectedRevision ?? (await deps.lifecycle.get(engineAgentId, slug, { includeToken: false })).revision
                        const removed = await deps.lifecycle.remove(engineAgentId, slug, { requestId, expectedRevision: revision }, guard)
                        return { text: M.deleted(slug), revision: removed.revision }
                    }),
                }),
            }
        },
    }
}

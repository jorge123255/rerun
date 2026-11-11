import { generateText, NoObjectGeneratedError, Output } from 'ai'
import { z } from 'zod'
import { providerSchema } from '@rerun/contracts'
import { isUsable, resolveConfiguredModel, resolveRunModel } from '../agents/availability.js'
import { getAgent } from '../agents/registry.js'
import { modelFor } from '../agents/providers.js'
import type { LoadedAgent } from '../agents/types.js'
import { ensureCliAuth } from '../connections/cli-auth.js'
import { findConnection } from '../connections/registry.js'
import { sameConnectionSnapshot } from '../connections/snapshot.js'
import type { LoadedConnection } from '../connections/types.js'
import { HttpError } from '../lib/errors.js'
import { computeNextRun, isValidTimezone } from '../schedules/next-run.js'
import { readSchedule } from '../schedules/loader.js'
import { beginDesktopApiConnectionWork } from './api-connections/admission.js'
import { assertDesktopProvider } from './policy.js'
import { authorizeDesktopSchedule } from './schedule-binding.js'
import { desktopScheduleDefinitionRevision } from './schedule-tools/revision.js'
import { resolveDesktopScheduleModel } from './schedule-model.js'

export const desktopScheduleDescriptionInputSchema = z.object({
    description: z.string().trim().min(1).max(1000),
    nowIso: z.string().datetime({ offset: true }),
    timezone: z.string().trim().min(1).max(100),
    connectionId: z.string().trim().min(1).max(256).nullable().default(null),
    provider: providerSchema.nullable().default(null),
    model: z.string().trim().min(1).max(256).nullable().default(null),
    slug: z.string().regex(/^[a-zA-Z0-9_-]{1,160}$/).optional(),
    expectedRevision: z.string().regex(/^[a-f0-9]{64}$/).optional(),
}).strict().superRefine((value, ctx) => {
    const fields = [value.connectionId, value.provider, value.model]
    if (value.slug || value.expectedRevision) {
        if (!value.slug || !value.expectedRevision || fields.some(field => field !== null)) {
            ctx.addIssue({ code: 'custom', message: 'Choose the saved routine revision without a model override' })
        }
        return
    }
    if (fields.every(field => field === null) || fields.every(field => field !== null)) return
    ctx.addIssue({ code: 'custom', message: 'Choose a connected provider and model, or follow the coworker default' })
})
export type DesktopScheduleDescriptionInput = z.infer<typeof desktopScheduleDescriptionInputSchema>
export type DesktopScheduleDescriptionResult = { status: 'ok'; value: unknown } | { status: 'invalid' | 'unavailable'; message: string }

const modelOutputSchema = z.object({
    mode: z.enum(['cron', 'runAt']),
    cron: z.string().trim().max(120).nullish(),
    runAt: z.string().trim().max(80).nullish(),
    timezone: z.string().trim().min(1).max(100).nullish(),
    label: z.string().trim().max(200).optional(),
}).strict()

function invalid(): DesktopScheduleDescriptionResult {
    return { status: 'invalid', message: 'The model returned an invalid schedule. Edit the description or enter cron or an ISO time manually.' }
}
function changed(): DesktopScheduleDescriptionResult {
    return { status: 'invalid', message: 'This routine changed. Refresh the editor before previewing again.' }
}
function unavailable(): DesktopScheduleDescriptionResult {
    return { status: 'unavailable', message: 'The selected local model is unavailable. Enter cron or an ISO time manually.' }
}

function extractJson(text: string): unknown {
    const match = text.match(/\{[\s\S]*\}/)
    if (!match) return null
    try { return JSON.parse(match[0]) } catch { return null }
}

function parseModelSchedule(text: string, input: DesktopScheduleDescriptionInput): DesktopScheduleDescriptionResult {
    const parsed = modelOutputSchema.safeParse(extractJson(text))
    if (!parsed.success) return invalid()
    const value = parsed.data
    if (value.timezone && !isValidTimezone(value.timezone)) return invalid()
    const now = Math.max(Date.now(), Date.parse(input.nowIso))
    if (value.mode === 'cron') {
        if (!value.cron || value.runAt) return invalid()
        if (!computeNextRun({ cron: value.cron, timezone: value.timezone ?? input.timezone }, new Date(now)).ok) return invalid()
    } else if (!value.runAt || value.cron || !z.string().datetime({ offset: true }).safeParse(value.runAt).success
        || Date.parse(value.runAt) <= now) return invalid()
    return { status: 'ok', value }
}

function schedulePrompt(input: DesktopScheduleDescriptionInput): string {
    return `You convert a natural-language schedule description into a structured schedule for a cron-like task runner.

Current time (ISO 8601): ${input.nowIso}
User timezone (IANA): ${input.timezone}

User description: ${JSON.stringify(input.description)}

Decide the mode:
- "cron" for a recurring schedule (e.g. "every day at 8am", "tous les lundis", "weekdays at noon").
- "runAt" for a one-shot single execution (e.g. "tomorrow at 3pm", "demain à 15h", "on June 30 at 9am").

Rules:
- For "cron", produce a standard 5-field cron expression: "minute hour day-of-month month day-of-week". Example: weekdays at 8am = "0 8 * * 1-5".
- For "runAt", produce an ISO 8601 instant (with timezone offset) for the next matching moment, resolved relative to the current time and user timezone.
- "timezone" is optional: include an IANA timezone string ONLY if the user explicitly mentions one; otherwise omit it.
- "label" is a short human-readable summary of the schedule, in the same language as the user description.

Respond with ONLY a JSON object, no prose, no code fences:
{ "mode": "cron" | "runAt", "cron": "...", "runAt": "...", "timezone": "...", "label": "..." }`
}

async function assertCurrentScheduleConnection(expected: LoadedConnection, model: string, signal: AbortSignal) {
    signal.throwIfAborted()
    const current = await findConnection(expected.id)
    signal.throwIfAborted()
    if (!current || !sameConnectionSnapshot(expected, current) || !isUsable(current, model)) {
        throw new HttpError(409, 'The selected connection changed. Preview was not accepted.')
    }
}

async function completeDesktopScheduleDescription(agent: LoadedAgent, input: DesktopScheduleDescriptionInput, signal: AbortSignal): Promise<string> {
    const releaseWork = beginDesktopApiConnectionWork()
    if (!releaseWork) throw new HttpError(409, 'A provider connection is being removed. Nothing new was started.')
    try {
        const requested = input.slug || input.model ? await resolveDesktopScheduleModel(agent, input) : undefined
        const resolved = requested ? await resolveRunModel(agent, requested) : await resolveConfiguredModel(agent.config)
        const connection = resolved.connection
        if (!connection || !isUsable(connection, resolved.model)) throw new HttpError(409, 'The selected local model is unavailable.')
        assertDesktopProvider(resolved.provider, connection.id)
        const override = { connectionId: connection.id, provider: resolved.provider, model: resolved.model }
        signal.throwIfAborted()
        const releaseAuth = await ensureCliAuth(resolved.provider, connection)
        try {
            await assertCurrentScheduleConnection(connection, resolved.model, signal)
            let text: string
            try {
                const result = await generateText({
                    model: modelFor({ ...agent, resolved }, override), output: Output.object({ schema: modelOutputSchema }), prompt: schedulePrompt(input),
                    maxOutputTokens: 1000, maxRetries: 0, abortSignal: signal, providerOptions: { openai: { store: false } },
                })
                text = result.text
            } catch (error) {
                if (NoObjectGeneratedError.isInstance(error) && error.text) text = error.text
                else throw error
            }
            await assertCurrentScheduleConnection(connection, resolved.model, signal)
            return text
        } finally { releaseAuth() }
    } finally { releaseWork() }
}

export async function describeDesktopSchedule(agentId: string, input: DesktopScheduleDescriptionInput, signal = AbortSignal.timeout(20_000)): Promise<DesktopScheduleDescriptionResult> {
    const parsed = desktopScheduleDescriptionInputSchema.parse(input)
    if (!isValidTimezone(parsed.timezone)) throw new HttpError(400, 'Choose a valid IANA timezone.')
    signal.throwIfAborted()
    await authorizeDesktopSchedule(agentId)
    signal.throwIfAborted()
    try {
        const current = parsed.slug ? await readSchedule(agentId, parsed.slug) : null
        signal.throwIfAborted()
        if (parsed.slug && desktopScheduleDefinitionRevision(current) !== parsed.expectedRevision) return changed()
        const selection = current ? { ...parsed, connectionId: current.connectionId, provider: current.provider, model: current.model } : parsed
        const agent = await getAgent(agentId)
        const text = await completeDesktopScheduleDescription(agent, selection, signal)
        signal.throwIfAborted()
        await authorizeDesktopSchedule(agentId)
        signal.throwIfAborted()
        if (parsed.slug) {
            const latest = await readSchedule(agentId, parsed.slug)
            signal.throwIfAborted()
            if (desktopScheduleDefinitionRevision(latest) !== parsed.expectedRevision) return changed()
        }
        return parseModelSchedule(text, parsed)
    } catch (error) {
        if (signal.aborted) throw error
        return unavailable()
    }
}

import { generateText, NoObjectGeneratedError, Output } from 'ai'
import { Cron } from 'croner'
import { z } from 'zod'
import { providerSchema } from '@rerun/contracts'
import { isUsable, resolveConfiguredModel, resolveRunModel } from '../agents/availability.js'
import { getAgent } from '../agents/registry.js'
import { modelFor } from '../agents/providers.js'
import type { LoadedAgent } from '../agents/types.js'
import { ensureCliAuth } from '../connections/cli-auth.js'
import { findConnection } from '../connections/registry.js'
import { HttpError } from '../lib/errors.js'
import { isValidTimezone } from '../schedules/next-run.js'
import { beginDesktopApiConnectionWork } from './api-connections/admission.js'
import { assertDesktopProvider } from './policy.js'
import { authorizeDesktopSchedule } from './schedule-binding.js'
import { resolveDesktopScheduleModel } from './schedule-model.js'

export const desktopScheduleDescriptionInputSchema = z.object({
    description: z.string().trim().min(1).max(1000),
    nowIso: z.string().datetime({ offset: true }),
    timezone: z.string().trim().min(1).max(100),
    connectionId: z.string().trim().min(1).max(256).nullable().default(null),
    provider: providerSchema.nullable().default(null),
    model: z.string().trim().min(1).max(256).nullable().default(null),
}).strict().superRefine((value, ctx) => {
    const fields = [value.connectionId, value.provider, value.model]
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
function unavailable(): DesktopScheduleDescriptionResult {
    return { status: 'unavailable', message: 'The selected local model is unavailable. Enter cron or an ISO time manually.' }
}

function extractJson(text: string): unknown {
    const match = text.match(/\{[\s\S]*\}/)
    if (!match) return null
    try { return JSON.parse(match[0]) } catch { return null }
}

function parseModelSchedule(text: string): DesktopScheduleDescriptionResult {
    const parsed = modelOutputSchema.safeParse(extractJson(text))
    if (!parsed.success) return invalid()
    const value = parsed.data
    if (value.timezone && !isValidTimezone(value.timezone)) return invalid()
    if (value.mode === 'cron') {
        if (!value.cron || value.runAt) return invalid()
        try { new Cron(value.cron, value.timezone ? { timezone: value.timezone } : undefined).nextRun() } catch { return invalid() }
    } else if (!value.runAt || value.cron || !z.string().datetime({ offset: true }).safeParse(value.runAt).success) return invalid()
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

async function completeDesktopScheduleDescription(agent: LoadedAgent, input: DesktopScheduleDescriptionInput, signal: AbortSignal): Promise<string> {
    const releaseWork = beginDesktopApiConnectionWork()
    if (!releaseWork) throw new HttpError(409, 'A provider connection is being removed. Nothing new was started.')
    try {
        if (input.model) await resolveDesktopScheduleModel(agent, input)
        const resolved = input.model ? await resolveRunModel(agent, input) : await resolveConfiguredModel(agent.config)
        const connection = resolved.connection
        if (!connection || !isUsable(connection, resolved.model)) throw new HttpError(409, 'The selected local model is unavailable.')
        assertDesktopProvider(resolved.provider, connection.id)
        const override = { connectionId: connection.id, provider: resolved.provider, model: resolved.model }
        signal.throwIfAborted()
        const releaseAuth = await ensureCliAuth(resolved.provider, connection)
        try {
            let text: string
            try {
                const result = await generateText({
                    model: modelFor(agent, override), output: Output.object({ schema: modelOutputSchema }), prompt: schedulePrompt(input),
                    maxOutputTokens: 1000, maxRetries: 0, abortSignal: signal, providerOptions: { openai: { store: false } },
                })
                text = result.text
            } catch (error) {
                if (NoObjectGeneratedError.isInstance(error) && error.text) text = error.text
                else throw error
            }
            signal.throwIfAborted()
            if (await findConnection(connection.id) !== connection) throw new HttpError(409, 'The selected connection changed. Preview was not accepted.')
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
        const agent = await getAgent(agentId)
        const text = await completeDesktopScheduleDescription(agent, parsed, signal)
        signal.throwIfAborted()
        return parseModelSchedule(text)
    } catch (error) {
        if (signal.aborted) throw error
        return unavailable()
    }
}

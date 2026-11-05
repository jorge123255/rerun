import { z } from 'zod'
import { contextTextPart, isContextPart, visibleText } from './chat-context.js'

// Original sub-run-watch.ts keeps this many recent tool rows and this much preview.
// The windows are explicit. A message, context, or finished answer over its max is refused whole.
export const DESKTOP_COWORKER_CALL_PREVIEW_CHARS = 600
export const DESKTOP_COWORKER_CALL_RECENT_CALLS = 8
export const DESKTOP_COWORKER_CALL_TITLE_CHARS = 80
export const DESKTOP_COWORKER_CALL_NAME_MAX_CHARS = 200
export const DESKTOP_COWORKER_CALL_MESSAGE_MAX_CHARS = 16_384
export const DESKTOP_COWORKER_CALL_CONTEXT_MAX_CHARS = 8_192
export const DESKTOP_COWORKER_CALL_RESULT_MAX_CHARS = 32_768
// Depth 0 is a user chat. Depths 0, 1 and 2 may call. The next call is refused.
export const DESKTOP_COWORKER_CALL_MAX_DEPTH = 3
// Counted per parent engine run, including calls that later fail. The next one is refused.
export const DESKTOP_COWORKER_CALL_MAX_FANOUT = 8
export const DESKTOP_COWORKER_CALL_REPLAY_WAIT_MS = 30_000
export const DESKTOP_COWORKER_CALL_INTERRUPTED_REASON = 'The coworker call was interrupted and was not restarted.'

export const desktopCoworkerCallStatuses = ['queued', 'running', 'dispatched', 'waiting-human', 'completed', 'error', 'cancelled', 'interrupted'] as const
export type DesktopCoworkerCallStatus = (typeof desktopCoworkerCallStatuses)[number]

const publicId = z.string().trim().min(1).max(256)
const isoTime = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
const callStatus = z.enum(['running', 'completed', 'error', 'cancelled'])

export const desktopCoworkerCallTargetSchema = z.strictObject({
    agentId: publicId,
    name: z.string().trim().min(1).max(DESKTOP_COWORKER_CALL_NAME_MAX_CHARS),
    handle: z.string().trim().min(1).max(DESKTOP_COWORKER_CALL_NAME_MAX_CHARS).nullable(),
    boxName: z.string().trim().min(1).max(60).nullable(),
    enabled: z.boolean(),
    callable: z.boolean(),
})
export type DesktopCoworkerCallTarget = z.infer<typeof desktopCoworkerCallTargetSchema>

export const desktopCoworkerMentionSchema = z.strictObject({
    targetId: publicId,
    token: z.string().min(2).max(201).startsWith('@').refine(value => !/[\p{Cc}]/u.test(value), 'Mention tokens stay on one line.'),
    start: z.number().int().min(0).max(20_000),
    end: z.number().int().min(1).max(20_000),
})
export const desktopCoworkerMentionsSchema = z.array(desktopCoworkerMentionSchema).max(100)
export type DesktopCoworkerMention = z.infer<typeof desktopCoworkerMentionSchema>
export type DesktopCoworkerMentionFields = { coworkerMentions?: DesktopCoworkerMention[] }
export const desktopCoworkerMentionFieldsOf = (mentions: readonly DesktopCoworkerMention[] | undefined): DesktopCoworkerMentionFields =>
    mentions?.length ? { coworkerMentions: [...mentions] } : {}

/** A selected token binds an exact ID/range; visible names never resolve an identity. */
export function checkedDesktopCoworkerMentions(text: string, value: unknown): DesktopCoworkerMention[] {
    const mentions = desktopCoworkerMentionsSchema.parse(value ?? []).map(item => ({ ...item }))
    let end = 0
    for (const item of mentions) {
        if (item.start < end || item.end <= item.start || item.end > text.length || text.slice(item.start, item.end) !== item.token
            || (item.start > 0 && !/\s/.test(text[item.start - 1]!))
            || (item.end < text.length && !/[\s.,;:!?)\]}'"]/.test(text[item.end]!))) throw new Error('A saved coworker mention no longer matches its text.')
        end = item.end
    }
    return mentions
}
export function validDesktopCoworkerMentionFields(input: { text: string; coworkerMentions?: DesktopCoworkerMention[] }): boolean {
    try { checkedDesktopCoworkerMentions(input.text, input.coworkerMentions); return true } catch { return false }
}
export function trimDesktopCoworkerMentions(text: string, value: readonly DesktopCoworkerMention[] | undefined) {
    const mentions = checkedDesktopCoworkerMentions(text, value)
    const start = text.length - text.trimStart().length, trimmed = text.trim()
    return { text: trimmed, ...desktopCoworkerMentionFieldsOf(checkedDesktopCoworkerMentions(trimmed, mentions.map(item => ({ ...item, start: item.start - start, end: item.end - start })))) }
}
export function desktopCoworkerMentionContextParts(text: string, value: readonly DesktopCoworkerMention[] | undefined) {
    const mentions = checkedDesktopCoworkerMentions(text, value)
    if (!mentions.length) return []
    const part = contextTextPart(`Selected coworker mentions (exact local identities chosen by the user):\n${JSON.stringify(mentions.map(({ token, targetId }) => ({ token, targetId })))}\nUse these IDs when referring to the selected coworkers. A mention does not grant permission or request an automatic coworker call.`)
    return [{ ...part, providerOptions: { rerun: { ...part.providerOptions.rerun, desktopCoworkerMentions: mentions } } }]
}
export function desktopStoredCoworkerMentions(content: unknown, strict = false): DesktopCoworkerMention[] {
    if (!Array.isArray(content)) return []
    const marked = content.filter(part => isContextPart(part) && part?.providerOptions?.rerun && Object.hasOwn(part.providerOptions.rerun, 'desktopCoworkerMentions'))
    if (!marked.length) return []
    try {
        if (marked.length !== 1) throw new Error('Duplicate saved coworker mention records.')
        return checkedDesktopCoworkerMentions(visibleText(content, ''), marked[0].providerOptions.rerun.desktopCoworkerMentions)
    } catch (error) { if (strict) throw error; return [] }
}

export const desktopCoworkerCallProgressSchema = z.strictObject({
    steps: z.number().int().nonnegative(),
    toolCalls: z.number().int().nonnegative(),
    failures: z.number().int().nonnegative(),
    preview: z.string().max(DESKTOP_COWORKER_CALL_PREVIEW_CHARS),
    calls: z.array(z.strictObject({ tool: z.string().min(1).max(120), status: callStatus })).max(DESKTOP_COWORKER_CALL_RECENT_CALLS),
})
export type DesktopCoworkerCallProgress = z.infer<typeof desktopCoworkerCallProgressSchema>

export const desktopCoworkerCallSnapshotSchema = z.strictObject({
    callId: z.string().uuid(),
    revision: z.string().regex(/^[0-9]{1,18}$/),
    parentAgentId: publicId,
    parentSessionId: publicId,
    parentRunId: publicId,
    toolCallId: publicId,
    targetAgentId: publicId,
    targetSessionId: publicId.nullable(),
    targetName: z.string().trim().min(1).max(DESKTOP_COWORKER_CALL_NAME_MAX_CHARS),
    wait: z.boolean(),
    status: z.enum(desktopCoworkerCallStatuses),
    createdAt: isoTime,
    updatedAt: isoTime,
    progress: desktopCoworkerCallProgressSchema,
})
export type DesktopCoworkerCallSnapshot = z.infer<typeof desktopCoworkerCallSnapshotSchema>

export const desktopCoworkerCallListSchema = z.strictObject({
    calls: z.array(desktopCoworkerCallSnapshotSchema),
})
export type DesktopCoworkerCallList = z.infer<typeof desktopCoworkerCallListSchema>

export const desktopCoworkerCallStopSchema = z.strictObject({
    operation: z.literal('stop'),
    requestId: z.string().uuid(),
    callId: z.string().uuid(),
    expectedRevision: z.string().regex(/^[0-9]{1,18}$/),
})
export type DesktopCoworkerCallStop = z.infer<typeof desktopCoworkerCallStopSchema>

export const desktopCoworkerCallStopResultSchema = z.strictObject({
    call: desktopCoworkerCallSnapshotSchema,
    error: z.string().max(1000).optional(),
})
export type DesktopCoworkerCallStopResult = z.infer<typeof desktopCoworkerCallStopResultSchema>

export type DesktopCoworkerCallPublicFields = {
    callId: string
    revision: number
    parentAgentId: string
    parentSessionId: string
    parentRunId: string
    toolCallId: string
    targetAgentId: string
    targetSessionId: string | null
    targetName: string
    wait: boolean
    status: DesktopCoworkerCallStatus
    createdAt: string
    updatedAt: string
    progress: DesktopCoworkerCallProgress
}

// The only browser snapshot. Engine ids are not accepted here.
export function desktopCoworkerCallSnapshotOf(input: DesktopCoworkerCallPublicFields): DesktopCoworkerCallSnapshot {
    return desktopCoworkerCallSnapshotSchema.parse({ ...input, revision: String(input.revision) })
}

export const desktopCoworkerCallFanoutError = () =>
    `This run already has ${DESKTOP_COWORKER_CALL_MAX_FANOUT} coworker calls. The limit is ${DESKTOP_COWORKER_CALL_MAX_FANOUT} and another call was not started.`

export const desktopCoworkerCallDepthError = () =>
    `This coworker call is nested ${DESKTOP_COWORKER_CALL_MAX_DEPTH} deep. The limit is ${DESKTOP_COWORKER_CALL_MAX_DEPTH} and another call was not started.`

export const desktopCoworkerCallResultLimitError = (name: string) =>
    `(error calling ${name}: the answer is longer than ${DESKTOP_COWORKER_CALL_RESULT_MAX_CHARS} characters and was not copied)`

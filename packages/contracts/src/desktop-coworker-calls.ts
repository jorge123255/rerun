import { z } from 'zod'

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

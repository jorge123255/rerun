import { z } from 'zod'
import type { Source } from './types.js'
const id = z.string().min(1).max(200)
export const sourceSchema = z.strictObject({ parentAgentId: id, parentSessionId: id, parentRunId: id, toolCallId: id })
export const engineSourceSchema = z.strictObject({ engineAgentId: id, sessionId: id, runId: id, toolCallId: id })
export type EngineSource = z.infer<typeof engineSourceSchema>
export type Allocation = {
    token: string; identity: string; revision: string; epoch: string; source: Source; taskId: string
    childAgentId: string; rootIdentity: string | null; sessionId: string | null; runId: string | null
    phase: 'reserved' | 'created' | 'running' | 'drained' | 'retired'
    cleanupStarted?: boolean
    manifest: { path: string; dev: string; ino: string; hash: string | null; size: number; directory: boolean }[] | null
}
export const stopSchema = z.strictObject({ operation: z.literal('stop-task'), requestId: z.string().uuid(), delegationId: z.string().uuid(), taskId: z.string().uuid(), expectedRevision: z.string().uuid() })
export const delegationIpcSchema = z.strictObject({ launchNonce: id, operation: z.enum(['authority','record-reserve','record-save','record-read','record-list','stop-read','stop-reserve','stop-settle','allocate','resource-read','resource-save','recover']), data: z.unknown() })

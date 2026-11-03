import { z } from 'zod'

// What the Team board knows about a coworker. `unreachable` is a failed read and must never look idle;
// `unknown` is the state before the first read lands.
export const boardActivityStatus = z.enum(['working', 'idle', 'unreachable'])
export type BoardActivityStatus = z.infer<typeof boardActivityStatus> | 'unknown'
export const boardActivitySchema = z.object({ agents: z.record(z.string(), boardActivityStatus) })
export type BoardActivity = z.infer<typeof boardActivitySchema>
export const BOARD_ACTIVITY_URL = '/api/desktop/board-activity'
export const BOARD_ACTIVITY_POLL_MS = 3000

import { describe, expect, it } from 'vitest'
import { desktopResumeDecision, desktopRunRecovery, replayedRunFailure, type DesktopOwnedRun } from './chat-resume'

const run = (patch: Partial<DesktopOwnedRun> & Pick<DesktopOwnedRun, 'id' | 'status'>): DesktopOwnedRun => ({
    agentId: 'engine-a', sessionId: 'engine-session', error: null, startedAt: '2026-11-06T00:00:00.000Z', ...patch,
})

describe('desktop run recovery', () => {
    it('replays only the newest failed run and ignores an older failure after a later reply', () => {
        const runs = [
            run({ id: 'old', status: 'error', error: 'missing key', startedAt: '2026-11-06T00:00:00.000Z' }),
            run({ id: 'new', status: 'done', startedAt: '2026-11-06T00:01:00.000Z' }),
        ]
        expect(desktopRunRecovery(runs, 'engine-a', 'engine-session')).toEqual({ activeRunId: null, lastError: null })
    })

    it('names the current running run and does not announce a failure while it is still going', () => {
        const runs = [
            run({ id: 'failed', status: 'error', error: 'old', startedAt: '2026-11-06T00:00:00.000Z' }),
            run({ id: 'live', status: 'running', startedAt: '2026-11-06T00:02:00.000Z' }),
        ]
        expect(desktopRunRecovery(runs, 'engine-a', 'engine-session')).toEqual({ activeRunId: 'live', lastError: null })
    })

    it('keeps a failed run that never wrote the same text into the transcript', () => {
        const recovery = desktopRunRecovery([run({ id: 'failed', status: 'error', error: 'The model refused the turn.' })], 'engine-a', 'engine-session')
        expect(recovery.lastError).toBe('The model refused the turn.')
        expect(replayedRunFailure([{ role: 'user', parts: [{ type: 'text', text: 'hello' }] }], recovery.lastError)).toBe('The model refused the turn.')
        expect(replayedRunFailure([{ role: 'assistant', parts: [{ type: 'text', text: 'The model refused the turn.' }] }], recovery.lastError)).toBeNull()
    })

    it('refuses to resume a foreign run, a finished run, or any id other than the live one', () => {
        const live = [run({ id: 'live', status: 'running', startedAt: '2026-11-06T00:03:00.000Z' })]
        expect(desktopResumeDecision(live, 'engine-a', 'engine-session', 'live')).toEqual({ action: 'stream', runId: 'live' })
        expect(desktopResumeDecision(live, 'engine-a', 'other-session', 'live')).toEqual({ action: 'unavailable', reason: 'identity' })
        expect(desktopResumeDecision(live, 'engine-b', 'engine-session', 'live')).toEqual({ action: 'unavailable', reason: 'identity' })
        expect(desktopResumeDecision([run({ id: 'done', status: 'done' })], 'engine-a', 'engine-session', 'done')).toEqual({ action: 'unavailable', reason: 'not-running' })
        expect(desktopResumeDecision(live, 'engine-a', 'engine-session', 'someone-else')).toEqual({ action: 'unavailable', reason: 'identity' })
    })
})

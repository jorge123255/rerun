import { describe, expect, it, vi } from 'vitest'
import { abortRun, activeRunCount, claimSession, registerRunAbort, releaseSession, sessionClaim, sessionClaimCount, setRunCancel, unregisterRunAbort, waitForRunCancellation } from './run-control.js'

describe('abortRun', () => {
    it('returns false for a run it never registered', () => {
        expect(abortRun('ghost')).toBe(false)
    })

    it('aborts the signal, runs the cancel hook, frees the claim and forgets the run', () => {
        const before = activeRunCount()
        const controller = registerRunAbort('run-a')
        const cancel = vi.fn()
        setRunCancel('run-a', cancel)
        expect(claimSession('sess-a', 'run-a')).toBeNull()
        expect(activeRunCount()).toBe(before + 1)

        expect(abortRun('run-a')).toBe(true)

        expect(controller.signal.aborted).toBe(true)
        expect(cancel).toHaveBeenCalledTimes(1)
        expect(sessionClaim('sess-a')).toBeNull()
        expect(activeRunCount()).toBe(before)
    })

    it('reports false on a second abort and does not cancel twice', () => {
        registerRunAbort('run-b')
        const cancel = vi.fn()
        setRunCancel('run-b', cancel)

        expect(abortRun('run-b')).toBe(true)
        expect(abortRun('run-b')).toBe(false)
        expect(cancel).toHaveBeenCalledTimes(1)
    })

    it('aborts a run that never set a cancel hook', () => {
        const controller = registerRunAbort('run-c')
        expect(abortRun('run-c')).toBe(true)
        expect(controller.signal.aborted).toBe(true)
    })

    it('keeps a desktop conversation claimed until cancellation persistence and teardown finish', async () => {
        vi.stubEnv('RERUN_DESKTOP_APP', '1')
        let finish!: () => void
        const gate = new Promise<void>(resolve => { finish = resolve })
        try {
            registerRunAbort('desktop-settling')
            claimSession('desktop-session', 'desktop-settling')
            setRunCancel('desktop-settling', () => gate)
            expect(abortRun('desktop-settling')).toBe(true)
            expect(claimSession('desktop-session', 'queued-next')).toBe('desktop-settling')
            let completed = false
            const stopped = waitForRunCancellation('desktop-settling').then(result => { completed = true; return result })
            await Promise.resolve()
            expect(completed).toBe(false)
            finish()
            expect(await stopped).toBe(true)
            expect(claimSession('desktop-session', 'queued-next')).toBeNull()
        } finally {
            finish()
            await waitForRunCancellation('desktop-settling')
            releaseSession('desktop-settling')
            releaseSession('queued-next')
            vi.unstubAllEnvs()
        }
    })

    it('bounds a desktop Stop wait without freeing a still-settling conversation', async () => {
        vi.stubEnv('RERUN_DESKTOP_APP', '1')
        vi.useFakeTimers()
        let finish!: () => void
        const gate = new Promise<void>(resolve => { finish = resolve })
        try {
            registerRunAbort('desktop-slow')
            claimSession('desktop-slow-session', 'desktop-slow')
            setRunCancel('desktop-slow', () => gate)
            abortRun('desktop-slow')
            const first = waitForRunCancellation('desktop-slow', 50)
            await vi.advanceTimersByTimeAsync(50)
            expect(await first).toBe(false)
            expect(sessionClaim('desktop-slow-session')?.runId).toBe('desktop-slow')
            expect(abortRun('desktop-slow')).toBe(false)
            const retry = waitForRunCancellation('desktop-slow', 50)
            finish()
            expect(await retry).toBe(true)
            expect(sessionClaim('desktop-slow-session')).toBeNull()
        } finally {
            finish()
            vi.useRealTimers()
            await waitForRunCancellation('desktop-slow')
            releaseSession('desktop-slow')
            vi.unstubAllEnvs()
        }
    })

    it('reports failed desktop settlement and releases its claim for a later retry', async () => {
        vi.stubEnv('RERUN_DESKTOP_APP', '1')
        try {
            registerRunAbort('desktop-failed')
            claimSession('desktop-failed-session', 'desktop-failed')
            setRunCancel('desktop-failed', async () => { throw new Error('persistence failed') })
            abortRun('desktop-failed')
            expect(await waitForRunCancellation('desktop-failed')).toBe(false)
            expect(sessionClaim('desktop-failed-session')).toBeNull()
        } finally { releaseSession('desktop-failed'); vi.unstubAllEnvs() }
    })
})

describe('setRunCancel', () => {
    it('ignores a run that is not registered', () => {
        const cancel = vi.fn()
        setRunCancel('not-registered', cancel)
        registerRunAbort('not-registered')
        abortRun('not-registered')
        expect(cancel).not.toHaveBeenCalled()
    })
})

describe('session claims', () => {
    it('does nothing when releasing a run that holds no claim', () => {
        claimSession('sess-held', 'holder')
        const count = sessionClaimCount()

        releaseSession('no-claim')

        expect(sessionClaimCount()).toBe(count)
        expect(sessionClaim('sess-held')?.runId).toBe('holder')
        releaseSession('holder')
    })

    it('records who holds a session and since when', () => {
        const before = Date.now()
        claimSession('sess-time', 'run-t')

        const claim = sessionClaim('sess-time')

        expect(claim?.runId).toBe('run-t')
        expect(claim?.claimedAt).toBeGreaterThanOrEqual(before)
        expect(claim?.claimedAt).toBeLessThanOrEqual(Date.now())
        releaseSession('run-t')
        expect(sessionClaim('sess-time')).toBeNull()
    })

    it('counts claimed sessions', () => {
        const before = sessionClaimCount()
        claimSession('sess-1', 'r1')
        claimSession('sess-2', 'r2')
        claimSession('sess-2', 'r3')

        expect(sessionClaimCount()).toBe(before + 2)

        releaseSession('r1')
        releaseSession('r2')
        expect(sessionClaimCount()).toBe(before)
    })

    it('keeps the holder claim when a refused run releases', () => {
        claimSession('sess-x', 'holder-x')
        expect(claimSession('sess-x', 'refused')).toBe('holder-x')

        releaseSession('refused')

        expect(sessionClaim('sess-x')?.runId).toBe('holder-x')
        releaseSession('holder-x')
    })

    it('unregistering a run frees its claim and drops it from the active count', () => {
        const before = activeRunCount()
        registerRunAbort('run-u')
        claimSession('sess-u', 'run-u')

        unregisterRunAbort('run-u')

        expect(activeRunCount()).toBe(before)
        expect(sessionClaim('sess-u')).toBeNull()
        expect(abortRun('run-u')).toBe(false)
    })

    it('remembers who started the run holding a conversation', () => {
        claimSession('sess-author', 'run-author', 'u1')
        expect(sessionClaim('sess-author')?.authorId).toBe('u1')
        releaseSession('run-author')
        claimSession('sess-author', 'run-unsigned')
        expect(sessionClaim('sess-author')?.authorId).toBeUndefined()
        releaseSession('run-unsigned')
    })
})

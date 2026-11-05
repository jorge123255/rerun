import { afterEach, describe, expect, it } from 'vitest'
import type { RunContext } from '../../runtime/context.js'
import { currentScreenRun, recordScreenUse, screenOwners } from './run-owner.js'

const context = (id = 'run-1', signal = new AbortController().signal) => ({ sessionId: 'session-1', runId: id, abortSignal: signal }) as RunContext
afterEach(() => screenOwners.clear())
describe('current screen run authority', () => {
    it('requires a recorded screen operation and an exact process-local claim', () => {
        const ctx = context()
        screenOwners.set('agent', ctx)
        expect(currentScreenRun('agent')).toBeNull()
        recordScreenUse(ctx, 'browser', 'https://www.example.com/private?token=secret#anchor')
        expect(currentScreenRun('agent')).toEqual({ sessionId: 'session-1', runId: 'run-1', kind: 'browser', site: 'example.com' })
        expect(currentScreenRun('another-agent')).toBeNull()
        screenOwners.delete('agent')
        expect(currentScreenRun('agent')).toBeNull()
    })
    it('never carries the previous run screen into a replacement or a restart', () => {
        const old = context()
        screenOwners.set('agent', old)
        recordScreenUse(old, 'browser', 'https://example.com')
        const next = context('run-2')
        screenOwners.set('agent', next)
        expect(currentScreenRun('agent')).toBeNull()
        recordScreenUse(next, 'computer')
        expect(currentScreenRun('agent')).toMatchObject({ runId: 'run-2', kind: 'computer', site: null })
        screenOwners.clear()
        expect(currentScreenRun('agent')).toBeNull()
    })
    it('revokes the stopped run immediately even before asynchronous cleanup completes', () => {
        const abort = new AbortController(), ctx = context('run-1', abort.signal)
        screenOwners.set('agent', ctx)
        recordScreenUse(ctx, 'computer')
        abort.abort()
        expect(currentScreenRun('agent')).toBeNull()
    })
    it('a setup context without a persisted run cannot supply live preview authority', () => {
        const ctx = { ...context(), runId: undefined }
        screenOwners.set('agent', ctx)
        recordScreenUse(ctx, 'browser', 'not a URL')
        expect(currentScreenRun('agent')).toBeNull()
    })
})

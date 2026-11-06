import { createHmac, randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import type { DesktopClaudePlanAction, DesktopClaudePlanSnapshot } from '@rerun/contracts'
import { createDesktopClaudePlanAuth, type ClaudeAuthPorts } from './auth'

const TOKEN = 'CLAUDE_CODE_OAUTH_TOKEN'
function fixture() {
    let saved: Record<string, string> = {}, now = 1_000, tail = Promise.resolve()
    const parts: ClaudeAuthPorts = {
        read: vi.fn(async () => ({ ...saved })), write: vi.fn(async value => { saved = { ...value } }),
        lock: work => { const pending = tail.then(work); tail = pending.then(() => {}, () => {}); return pending },
        exchange: vi.fn(async () => ({ accessToken: 'fresh-access', refreshToken: 'fresh-refresh', expiresAt: 1_000_000 })),
        fingerprint: value => createHmac('sha256', 'test-only-key').update(value).digest('hex'), available: () => true,
        beforeCredentialChange: vi.fn(async () => {}), changed: vi.fn(async () => {}), now: () => now, launchNonce: 'launch-a',
    }
    return { parts, get saved() { return saved }, seed: (value: Record<string, string>) => { saved = value }, advance: () => { now += 900_001 } }
}
const action = (operation: 'start' | 'cancel' | 'disconnect', state: DesktopClaudePlanSnapshot): DesktopClaudePlanAction => ({ operation, requestId: randomUUID(), attemptId: state.attemptId, expectedRevision: state.revision })
const finish = (state: DesktopClaudePlanSnapshot): DesktopClaudePlanAction => ({ operation: 'complete', requestId: randomUUID(), attemptId: state.attemptId, expectedRevision: state.revision, code: 'one-time-code' })
const signal = () => new AbortController().signal
async function deferredFixture() {
    const f = fixture()
    let complete!: (value: { accessToken: string }) => void, entered!: () => void
    const started = new Promise<void>(resolve => { entered = resolve })
    f.parts.exchange = vi.fn(() => { entered(); return new Promise(resolve => { complete = resolve }) })
    const auth = createDesktopClaudePlanAuth(f.parts), waiting = await auth.action(action('start', await auth.status()), signal())
    const request = finish(waiting), pending = auth.action(request, signal())
    await started
    return { f, auth, waiting, pending, request, complete }
}

describe('canonical desktop Claude sign-in', () => {
    it('reads status without creating a connection, writes, exchanges or spawning', async () => {
        const f = fixture(), auth = createDesktopClaudePlanAuth(f.parts)
        expect(await auth.status()).toMatchObject({ phase: 'idle', attemptId: null, revision: '0' })
        expect(f.parts.write).not.toHaveBeenCalled(); expect(f.parts.exchange).not.toHaveBeenCalled(); expect(f.parts.beforeCredentialChange).not.toHaveBeenCalled()
    })
    it('uses an exact attempt and durable request identity; repeated completion never exchanges twice', async () => {
        const f = fixture(), auth = createDesktopClaudePlanAuth(f.parts)
        const start = action('start', await auth.status()), waiting = await auth.action(start, signal())
        expect(await auth.action(start, signal())).toEqual(waiting)
        const request = finish(waiting), connected = await auth.action(request, signal())
        expect(connected.phase).toBe('connected')
        expect(await auth.action(request, signal())).toEqual(connected)
        expect(f.parts.exchange).toHaveBeenCalledTimes(1)
        expect(f.saved[TOKEN]).toBe('fresh-access')
        for (const privateValue of ['fresh-access', 'fresh-refresh', 'one-time-code', 'verifier', 'fingerprint']) expect(JSON.stringify(connected)).not.toContain(privateValue)
        await expect(auth.action({ ...request, code: 'changed-code' } as DesktopClaudePlanAction, signal())).rejects.toThrow('changed')
    })
    it('cancels the exact checking attempt and refuses a late provider response', async () => {
        const { auth, f, pending, complete } = await deferredFixture()
        const checking = await auth.status(), cancelled = await auth.action(action('cancel', checking), signal())
        complete({ accessToken: 'must-not-be-saved' })
        expect((await pending).phase).toBe('cancelled')
        expect(cancelled.phase).toBe('cancelled'); expect(f.saved[TOKEN]).toBeUndefined()
    })
    it('a stale close cannot cancel a newer attempt', async () => {
        const f = fixture(), auth = createDesktopClaudePlanAuth(f.parts)
        const first = await auth.action(action('start', await auth.status()), signal())
        const second = await auth.action(action('start', first), signal())
        await expect(auth.action(action('cancel', first), signal())).rejects.toThrow('changed')
        expect((await auth.status()).attemptId).toBe(second.attemptId)
    })
    it('reopening interrupted checking is passive and does not re-exchange a code', async () => {
        const { auth, f, pending, complete } = await deferredFixture()
        auth.stop()
        const reopened = createDesktopClaudePlanAuth({ ...f.parts, launchNonce: 'launch-b' })
        expect(await reopened.status()).toMatchObject({ phase: 'error', error: expect.stringContaining('interrupted') })
        expect(f.parts.exchange).toHaveBeenCalledTimes(1)
        complete({ accessToken: 'late-token' }); await pending
        expect(f.saved[TOKEN]).toBeUndefined()
    })
    it('does not replace existing credentials if old workers cannot be drained', async () => {
        const f = fixture(); f.seed({ [TOKEN]: 'existing-access' })
        f.parts.beforeCredentialChange = vi.fn(async () => { throw new Error('still running') })
        const auth = createDesktopClaudePlanAuth(f.parts), waiting = await auth.action(action('start', await auth.status()), signal())
        expect((await auth.action(finish(waiting), signal())).phase).toBe('error')
        expect(f.saved[TOKEN]).toBe('existing-access')
    })
    it('expires on a passive read, preserving an existing credential without exchanging', async () => {
        const f = fixture(); f.seed({ [TOKEN]: 'existing-access' })
        const auth = createDesktopClaudePlanAuth(f.parts)
        await auth.action(action('start', await auth.status()), signal()); f.advance()
        expect((await auth.status()).phase).toBe('expired')
        expect(f.parts.exchange).not.toHaveBeenCalled(); expect(f.saved[TOKEN]).toBe('existing-access')
    })
    it('accepts an explicit setup token, clears refresh material and disconnects with CAS', async () => {
        const f = fixture(), auth = createDesktopClaudePlanAuth(f.parts), first = await auth.status()
        const token = `sk-ant-oat01-${'x'.repeat(32)}`
        const connected = await auth.action({ ...action('start', first), operation: 'token', token }, signal())
        expect(connected.phase).toBe('connected'); expect(f.saved[TOKEN]).toBe(token)
        const disconnected = await auth.action(action('disconnect', connected), signal())
        expect(disconnected.phase).toBe('disconnected'); expect(f.saved[TOKEN]).toBeUndefined()
        expect(f.parts.beforeCredentialChange).toHaveBeenCalledTimes(2)
    })
})

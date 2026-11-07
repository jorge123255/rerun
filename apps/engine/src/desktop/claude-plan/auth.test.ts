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
        const f = fixture(); f.seed({ [TOKEN]: 'existing-access', RERUN_CLAUDE_CREDENTIAL_REVISION: '3' })
        f.parts.beforeCredentialChange = vi.fn(async () => { throw new Error('still running') })
        const auth = createDesktopClaudePlanAuth(f.parts), waiting = await auth.action(action('start', await auth.status()), signal())
        const failed = await auth.action(finish(waiting), signal())
        // Durable generation stays linked; replacement failure is explicit without deleting the token.
        expect(failed.phase).toBe('connected')
        expect(failed.credentialRevision).toBe('3')
        expect(failed.error).toMatch(/could not be confirmed/)
        expect(f.saved[TOKEN]).toBe('existing-access')
        expect(f.parts.beforeCredentialChange).toHaveBeenCalled()
    })
    it('expires on a passive read, preserving an existing credential without exchanging', async () => {
        const f = fixture(); f.seed({ [TOKEN]: 'existing-access', RERUN_CLAUDE_CREDENTIAL_REVISION: '2' })
        const auth = createDesktopClaudePlanAuth(f.parts)
        await auth.action(action('start', await auth.status()), signal()); f.advance()
        const snapshot = await auth.status()
        // Expired replacement attempt must not hide the still-executable generation.
        expect(snapshot.phase).toBe('connected')
        expect(snapshot.credentialRevision).toBe('2')
        expect(snapshot.pendingAttempt).toBeUndefined()
        expect(f.parts.exchange).not.toHaveBeenCalled(); expect(f.saved[TOKEN]).toBe('existing-access')
    })
    it('accepts an explicit setup token, clears refresh material and disconnects with CAS', async () => {
        const f = fixture(), auth = createDesktopClaudePlanAuth(f.parts), first = await auth.status()
        const token = `sk-ant-oat01-${'x'.repeat(32)}`
        const connected = await auth.action({ ...action('start', first), operation: 'token', token }, signal())
        expect(connected.phase).toBe('connected'); expect(f.saved[TOKEN]).toBe(token)
        expect(connected.attemptId).toBeNull()
        await expect(auth.action(action('disconnect', first), signal())).rejects.toThrow('changed')
        const disconnected = await auth.action(action('disconnect', connected), signal())
        expect(disconnected.phase).toBe('disconnected'); expect(f.saved[TOKEN]).toBeUndefined()
        expect(f.parts.beforeCredentialChange).toHaveBeenCalledTimes(2)
    })

    it('start/cancel of a replacement keep the active generation connected and do not delete the token', async () => {
        const f = fixture(); f.seed({ [TOKEN]: 'live-access', RERUN_CLAUDE_CREDENTIAL_REVISION: '7' })
        const auth = createDesktopClaudePlanAuth(f.parts)
        const waiting = await auth.action(action('start', await auth.status()), signal())
        expect(waiting.phase).toBe('connected')
        expect(waiting.credentialRevision).toBe('7')
        expect(waiting.pendingAttempt).toMatchObject({ phase: 'waiting', attemptId: waiting.attemptId })
        expect(waiting.authorizeUrl).toMatch(/^https:\/\/claude\.ai\/oauth\/authorize/)
        expect(f.saved[TOKEN]).toBe('live-access')
        for (const privateValue of ['live-access', 'verifier']) expect(JSON.stringify(waiting)).not.toContain(privateValue)

        const cancelled = await auth.action(action('cancel', waiting), signal())
        expect(cancelled.phase).toBe('connected')
        expect(cancelled.credentialRevision).toBe('7')
        expect(cancelled.pendingAttempt).toBeUndefined()
        expect(cancelled.error).toBeUndefined()
        expect(f.saved[TOKEN]).toBe('live-access')
    })

    it('failed replacement exchange leaves the prior token and reports connected with an error', async () => {
        const f = fixture(); f.seed({ [TOKEN]: 'live-access', RERUN_CLAUDE_CREDENTIAL_REVISION: '4' })
        f.parts.exchange = vi.fn(async () => { throw new Error('provider rejected') })
        const auth = createDesktopClaudePlanAuth(f.parts)
        const waiting = await auth.action(action('start', await auth.status()), signal())
        const failed = await auth.action(finish(waiting), signal())
        expect(failed.phase).toBe('connected')
        expect(failed.credentialRevision).toBe('4')
        expect(failed.error).toMatch(/could not be confirmed/)
        expect(f.saved[TOKEN]).toBe('live-access')
        expect(f.parts.beforeCredentialChange).not.toHaveBeenCalled()
    })

    it('successful replacement drains workers before swapping the token and bumps generation', async () => {
        const f = fixture(); f.seed({ [TOKEN]: 'old-access', RERUN_CLAUDE_CREDENTIAL_REVISION: '1' })
        const order: string[] = []
        f.parts.beforeCredentialChange = vi.fn(async () => { expect(f.saved[TOKEN]).toBe('old-access'); order.push('drain') })
        const originalWrite = f.parts.write
        f.parts.write = vi.fn(async value => {
            // Waiting/checking attempt state is durable before exchange. Only a change to
            // credential material must wait for old workers to drain.
            order.push(value[TOKEN] !== f.saved[TOKEN] ? 'credential-write' : 'attempt-write')
            await originalWrite(value)
        })
        const auth = createDesktopClaudePlanAuth(f.parts)
        const waiting = await auth.action(action('start', await auth.status()), signal())
        const connected = await auth.action(finish(waiting), signal())
        expect(connected.phase).toBe('connected')
        expect(connected.credentialRevision).toBe('2')
        expect(connected.pendingAttempt).toBeUndefined()
        expect(f.saved[TOKEN]).toBe('fresh-access')
        expect(order.indexOf('drain')).toBeGreaterThan(-1)
        expect(order.indexOf('attempt-write')).toBeLessThan(order.indexOf('drain'))
        expect(order.filter(step => step === 'credential-write')).toHaveLength(1)
        expect(order.indexOf('credential-write')).toBeGreaterThan(order.indexOf('drain'))
    })

    it('disconnect drains then deletes the active token; late exchange cannot restore it', async () => {
        const f = fixture(); f.seed({ [TOKEN]: 'live-access', RERUN_CLAUDE_CREDENTIAL_REVISION: '5' })
        let complete!: (value: { accessToken: string }) => void, entered!: () => void
        const started = new Promise<void>(resolve => { entered = resolve })
        f.parts.exchange = vi.fn(() => { entered(); return new Promise(resolve => { complete = resolve }) })
        const auth = createDesktopClaudePlanAuth(f.parts)
        const waiting = await auth.action(action('start', await auth.status()), signal())
        const pending = auth.action(finish(waiting), signal())
        await started
        await expect(auth.action(action('disconnect', await auth.status()), signal())).rejects.toThrow(/Cancel this sign-in/)
        const cancelled = await auth.action(action('cancel', await auth.status()), signal())
        expect(cancelled.phase).toBe('connected')
        expect(f.saved[TOKEN]).toBe('live-access')
        const gone = await auth.action(action('disconnect', cancelled), signal())
        expect(gone.phase).toBe('disconnected')
        expect(gone.credentialRevision).toBeUndefined()
        expect(f.saved[TOKEN]).toBeUndefined()
        expect(f.parts.beforeCredentialChange).toHaveBeenCalled()
        complete({ accessToken: 'stale-should-not-land' })
        expect((await pending).phase).toBe('disconnected')
        expect(f.saved[TOKEN]).toBeUndefined()
    })

    it('projectDesktopClaudePlanSnapshot keeps no-token waiting and redacts secrets', async () => {
        const { projectDesktopClaudePlanSnapshot } = await import('./auth')
        const waitingOnly = projectDesktopClaudePlanSnapshot({
            attemptId: '11111111-1111-4111-8111-111111111111', revision: '1', phase: 'waiting', startId: '22222222-2222-4222-8222-222222222222',
            expires: 50_000, verifier: 'secret-verifier', state: 'secret-state', authorizeUrl: 'https://claude.ai/oauth/authorize?x=1',
            predecessor: '0', launchNonce: 'launch-a',
        }, {}, 1_000, 'launch-a')
        expect(waitingOnly.phase).toBe('waiting')
        expect(waitingOnly.credentialRevision).toBeUndefined()
        expect(JSON.stringify(waitingOnly)).not.toContain('secret-verifier')
        expect(projectDesktopClaudePlanSnapshot(null, {}, 1_000, 'launch-a')).toMatchObject({ phase: 'idle', attemptId: null })
    })

})

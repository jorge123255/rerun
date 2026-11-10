import { createHmac } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import { DESKTOP_CLAUDE_CONNECTION_ID, type DesktopClaudePlanAction, type DesktopClaudePlanSnapshot } from '@rerun/contracts'
import { createDesktopClaudePlanAuth, type ClaudeAuthPorts } from './auth.js'

const TOKEN = 'CLAUDE_CODE_OAUTH_TOKEN'
const GENERATION = 'RERUN_CLAUDE_CREDENTIAL_REVISION'
const AUTH = 'RERUN_CLAUDE_LOGIN_STATE'
const signal = () => new AbortController().signal
function journey() {
    // In-memory custody port only. Production encryption/Keychain never runs in this fixture.
    let saved: Record<string, string> = {}, tail = Promise.resolve(), serial = 0
    const order: string[] = []
    const ports: ClaudeAuthPorts = {
        read: async () => ({ ...saved }),
        write: vi.fn(async value => { order.push(value[TOKEN] !== saved[TOKEN] ? 'credential-write' : 'attempt-write'); saved = { ...value } }),
        lock: work => { const pending = tail.then(work); tail = pending.then(() => {}, () => {}); return pending },
        exchange: vi.fn(async () => ({ accessToken: 'synthetic-access', refreshToken: 'synthetic-refresh', expiresAt: 1000000 })),
        fingerprint: value => createHmac('sha256', 'synthetic-fixture-key').update(value).digest('hex'),
        available: () => true, beforeCredentialChange: vi.fn(async () => { order.push('drain') }), changed: vi.fn(async () => { order.push('changed') }), now: () => 1000, launchNonce: 'launch-a',
    }
    const input = (operation: 'start' | 'cancel' | 'disconnect' | 'complete', state: DesktopClaudePlanSnapshot): DesktopClaudePlanAction => {
        const guard = { requestId: `00000000-0000-4000-8000-${String(++serial).padStart(12, '0')}`, attemptId: state.attemptId, expectedRevision: state.revision }
        return operation === 'complete' ? { ...guard, operation, code: 'synthetic-code' } : { ...guard, operation }
    }
    return { ports, input, order, get saved() { return saved } }
}

it('first sign-in, passive restart, superseded reconnect and cancel preserve one credential lineage', async () => {
    const f = journey()
    let auth = createDesktopClaudePlanAuth(f.ports)
    expect(await auth.status()).toMatchObject({ connectionId: DESKTOP_CLAUDE_CONNECTION_ID, phase: 'idle', attemptId: null })
    expect(f.ports.write).not.toHaveBeenCalled()
    const waiting = await auth.action(f.input('start', await auth.status()), signal())
    expect(waiting.phase).toBe('waiting')
    const complete = f.input('complete', waiting)
    const linked = await auth.action(complete, signal())
    expect(linked).toMatchObject({ connectionId: 'mac-claude', phase: 'connected', credentialRevision: '1', attemptId: null })
    expect(await auth.action(complete, signal())).toEqual(linked)
    expect(f.ports.exchange).toHaveBeenCalledTimes(1)
    expect(f.order.indexOf('drain')).toBeLessThan(f.order.indexOf('credential-write'))
    for (const value of ['synthetic-access', 'synthetic-refresh', 'synthetic-code', 'verifier']) expect(JSON.stringify(linked)).not.toContain(value)
    expect(JSON.parse(f.saved[AUTH]).verifier).toBeUndefined()
    auth.stop()
    auth = createDesktopClaudePlanAuth({ ...f.ports, launchNonce: 'launch-b' })
    expect(await auth.status()).toEqual(linked)
    expect(f.ports.exchange).toHaveBeenCalledTimes(1)

    let finish!: (credential: { accessToken: string }) => void, enter!: () => void
    const entered = new Promise<void>(resolve => { enter = resolve })
    f.ports.exchange = vi.fn(async () => { enter(); return new Promise<{ accessToken: string }>(resolve => { finish = resolve }) })
    // Recreate to inject the delayed provider; reuse exactly the same durable custody and lock.
    auth.stop(); auth = createDesktopClaudePlanAuth({ ...f.ports, launchNonce: 'launch-c' })
    const a = await auth.action(f.input('start', await auth.status()), signal())
    const staleInput = f.input('complete', a), pending = auth.action(staleInput, signal())
    await entered
    const b = await auth.action(f.input('start', await auth.status()), signal())
    expect(b.pendingAttempt?.attemptId).not.toBe(a.attemptId)
    expect(b.credentialRevision).toBe('1')
    finish({ accessToken: 'synthetic-stale-must-not-land' })
    expect(await pending).toEqual(b)
    expect(f.saved[TOKEN]).toBe('synthetic-access')
    await expect(auth.action(staleInput, signal())).rejects.toThrow(/changed/)
    const cancelled = await auth.action(f.input('cancel', b), signal())
    expect(cancelled).toMatchObject({ phase: 'connected', credentialRevision: '1', attemptId: null })
    expect(cancelled.pendingAttempt).toBeUndefined()
    expect(f.saved[GENERATION]).toBe('1')
    auth.stop()
    f.ports.exchange = vi.fn(async () => ({ accessToken: 'synthetic-replacement' }))
    auth = createDesktopClaudePlanAuth({ ...f.ports, launchNonce: 'launch-d' })
    const replacement = await auth.action(f.input('start', await auth.status()), signal())
    const reconnected = await auth.action(f.input('complete', replacement), signal())
    expect(reconnected).toMatchObject({ connectionId: 'mac-claude', phase: 'connected', credentialRevision: '2', attemptId: null })
    expect(f.saved[TOKEN]).toBe('synthetic-replacement')
    expect(f.ports.beforeCredentialChange).toHaveBeenCalledTimes(2)
    expect(f.order.slice(-3)).toEqual(['drain', 'credential-write', 'changed'])
    await expect(auth.action(staleInput, signal())).rejects.toThrow(/changed/)
    auth.stop()
})

it('rejected initial/replacement exchanges publish safe errors without destroying a saved connection', async () => {
    const f = journey()
    f.ports.exchange = vi.fn(async () => { throw new Error('synthetic provider rejection with private detail') })
    const auth = createDesktopClaudePlanAuth(f.ports)
    const waiting = await auth.action(f.input('start', await auth.status()), signal())
    const rejected = await auth.action(f.input('complete', waiting), signal())
    expect(rejected.phase).toBe('error')
    expect(f.saved[TOKEN]).toBeUndefined()
    expect(JSON.stringify(rejected)).not.toContain('private detail')
    f.ports.exchange = vi.fn(async () => ({ accessToken: 'synthetic-valid' }))
    const next = await auth.action(f.input('start', rejected), signal())
    const connected = await auth.action(f.input('complete', next), signal())
    f.ports.exchange = vi.fn(async () => { throw new Error('synthetic rejection') })
    const replacement = await auth.action(f.input('start', connected), signal())
    const failed = await auth.action(f.input('complete', replacement), signal())
    expect(failed).toMatchObject({ phase: 'connected', credentialRevision: '1' })
    expect(failed.error).toContain('could not be confirmed')
    expect(f.saved[TOKEN]).toBe('synthetic-valid')
    const gone = await auth.action(f.input('disconnect', failed), signal())
    expect(gone.phase).toBe('disconnected')
    expect(f.saved[TOKEN]).toBeUndefined()
    expect(f.saved[GENERATION]).toBe('2')
    auth.stop()
})

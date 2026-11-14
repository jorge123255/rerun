import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { afterEach, expect, test, vi } from 'vitest'
import type { DesktopSubscriptionProvider } from '@rerun/contracts'
import { bindDesktopSubscriptionDeviceLogin } from './device-login.js'
import { desktopSubscriptionDeviceOutput } from './device-output.js'

function output(provider: DesktopSubscriptionProvider, code = 'TEST-QA22') {
    if (provider === 'grok-build') {
        return `To sign in, open this URL in your browser:\n  https://auth.x.ai/device?user_code=${code}\nThen enter this code:\n  ${code}\n`
    }
    return `Opening browser for Kimi device login: https://auth.kimi.ai/device?user_code=${code}\nIf the browser did not open, paste the URL above and enter code: ${code}\n`
}

function fixture() {
    const approved = new Set<DesktopSubscriptionProvider>()
    const workers = new Map<DesktopSubscriptionProvider, ChildProcessWithoutNullStreams>()
    const dispose = vi.fn(async () => {})
    const discard = vi.fn()
    const relayClose = vi.fn(async () => {})
    const ports = {
        available: vi.fn(() => true),
        approved: (provider: DesktopSubscriptionProvider) => approved.has(provider),
        forget: (provider: DesktopSubscriptionProvider) => { approved.delete(provider) },
        relay: vi.fn(async () => ({ port: 1, proxy: 'http://fixture.invalid', close: relayClose })),
        create: vi.fn((provider: DesktopSubscriptionProvider) => ({
            launch() {
                const process = Object.assign(new EventEmitter(), {
                    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
                }) as unknown as ChildProcessWithoutNullStreams
                workers.set(provider, process)
                return { child: process, dispose }
            },
            approve() { approved.add(provider) },
            discard,
        })),
    }
    const login = bindDesktopSubscriptionDeviceLogin(ports)
    async function worker(provider: DesktopSubscriptionProvider) {
        await vi.waitFor(() => expect(workers.has(provider)).toBe(true))
        return workers.get(provider)!
    }
    return { ports, approved, login, worker, dispose, discard, relayClose }
}

afterEach(() => vi.useRealTimers())

test.each(['grok-build', 'kimi-code'] as const)('publishes a bounded public challenge for %s', (provider) => {
    const seen = vi.fn()
    const parse = desktopSubscriptionDeviceOutput(provider, seen)
    const text = output(provider).replace('/device?', '/device?device_code=private&')
    for (const part of Buffer.from(text)) parse(Buffer.from([part]))
    expect(seen).toHaveBeenCalledExactlyOnceWith({
        // Kimi's page needs the code in its address; nothing else of the runner's query is kept.
        verificationUrl: provider === 'grok-build' ? 'https://auth.x.ai/device' : `https://auth.kimi.ai/device?user_code=${'TEST-QA22'}`,
        userCode: 'TEST-QA22',
    })
})

test('refuses foreign verification hosts and mismatched device codes', () => {
    const seen = vi.fn()
    const parse = desktopSubscriptionDeviceOutput('grok-build', seen)
    parse(Buffer.from(output('grok-build').replace('auth.x.ai/', 'auth.x.ai.attacker.invalid/')))
    parse(Buffer.from(output('grok-build').replace('user_code=TEST-QA22', 'user_code=ANOTHER-CODE')))
    expect(seen).not.toHaveBeenCalled()
})

test('ignores an oversized login banner', () => {
    const seen = vi.fn()
    const parse = desktopSubscriptionDeviceOutput('kimi-code', seen)
    parse(Buffer.alloc(256 * 1024 + 1, 32))
    parse(Buffer.from(output('kimi-code')))
    expect(seen).not.toHaveBeenCalled()
})

test('publishes approval after the exact runner exits and preserves the saved outcome on reopen', async () => {
    const f = fixture()
    await f.login.action({ provider: 'grok-build', action: 'start' })
    await f.login.action({ provider: 'grok-build', action: 'start' })
    expect(f.ports.create).toHaveBeenCalledTimes(1)
    const worker = await f.worker('grok-build')
    worker.stderr.write(output('grok-build'))
    expect(f.login.snapshot()['grok-build']).toMatchObject({ phase: 'waiting', userCode: 'TEST-QA22' })
    expect(f.login.snapshot()['kimi-code']).toEqual({ phase: 'idle' })
    worker.emit('close', 0, null)
    await vi.waitFor(() => expect(f.login.snapshot()['grok-build']).toEqual({ phase: 'approved' }))
    expect(f.dispose).toHaveBeenCalled()
    expect(f.relayClose).toHaveBeenCalled()
    expect(f.discard).not.toHaveBeenCalled()
    const restarted = bindDesktopSubscriptionDeviceLogin(f.ports)
    expect(restarted.snapshot()['grok-build']).toEqual({ phase: 'approved' })
    await restarted.action({ provider: 'grok-build', action: 'disconnect' })
    expect(restarted.snapshot()['grok-build']).toEqual({ phase: 'idle' })
})

test('cancelling while the runner is waiting discards the profile and ignores a late successful exit', async () => {
    const f = fixture()
    await f.login.action({ provider: 'kimi-code', action: 'start' })
    const worker = await f.worker('kimi-code')
    worker.stderr.write(output('kimi-code'))
    const cancelled = f.login.action({ provider: 'kimi-code', action: 'cancel' })
    worker.emit('close', 0, null)
    expect((await cancelled)['kimi-code']).toEqual({ phase: 'idle' })
    expect(f.approved.has('kimi-code')).toBe(false)
    expect(f.discard).toHaveBeenCalledTimes(1)
})

test('refuses runner success without a recognized device challenge', async () => {
    const f = fixture()
    await f.login.action({ provider: 'grok-build', action: 'start' })
    const worker = await f.worker('grok-build')
    worker.emit('close', 0, null)
    await vi.waitFor(() => expect(f.login.snapshot()['grok-build']).toEqual({ phase: 'error', reason: 'failed' }))
    expect(f.approved.size).toBe(0)
    expect(f.discard).toHaveBeenCalled()
})

test('cancels all pending attempts when workspace admissions freeze', async () => {
    const f = fixture()
    await Promise.all(['grok-build', 'kimi-code'].map(provider => f.login.action({
        provider: provider as DesktopSubscriptionProvider, action: 'start',
    })))
    await f.login.cancelPending()
    expect(f.login.snapshot()).toEqual({ 'grok-build': { phase: 'idle' }, 'kimi-code': { phase: 'idle' }, devin: { phase: 'idle' } })
    expect(f.discard).toHaveBeenCalledTimes(2)
})

test('expires a pending attempt without saving an account', async () => {
    vi.useFakeTimers()
    const f = fixture()
    const login = bindDesktopSubscriptionDeviceLogin(f.ports, 500)
    await login.action({ provider: 'kimi-code', action: 'start' })
    await vi.advanceTimersByTimeAsync(500)
    expect(login.snapshot()['kimi-code']).toEqual({ phase: 'error', reason: 'expired' })
    expect(f.discard).toHaveBeenCalledTimes(1)
})

test('Devin publishes its sign-in page and no device code', () => {
    const seen = vi.fn()
    const parse = desktopSubscriptionDeviceOutput('devin', seen)
    parse(Buffer.from('2026-11-14T07:00:00Z  INFO chisel: startup\nVisit https://app.devin.ai/auth/cli/continue?state=abc&code_challenge=xyz&code_challenge_method=S256 to sign in, then copy the code and paste it below.\n'))
    expect(seen).toHaveBeenCalledExactlyOnceWith({ verificationUrl: 'https://app.devin.ai/auth/cli/continue?state=abc&code_challenge=xyz&code_challenge_method=S256' })
    // An address on any other host is not shown.
    const other = vi.fn()
    desktopSubscriptionDeviceOutput('devin', other)(Buffer.from('Visit https://example.com/login?state=abc to sign in, then copy the code and paste it below.\n'))
    expect(other).not.toHaveBeenCalled()
})

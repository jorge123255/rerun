import { once } from 'node:events'
import { randomUUID } from 'node:crypto'
import type {
    DesktopSubscriptionLoginAction,
    DesktopSubscriptionLoginSnapshot,
    DesktopSubscriptionLoginStatus,
    DesktopSubscriptionProvider,
} from '@rerun/contracts'
import { desktopSubscriptionDeviceOutput } from './device-output.js'
import { openDesktopSubscriptionDeviceRelay } from './device-relay.js'
import {
    createDesktopSubscriptionDeviceAttempt,
    desktopSubscriptionDeviceApproved,
    desktopSubscriptionDeviceLoginAvailable,
    forgetDesktopSubscriptionDeviceApproval,
} from './runtime.js'

const deviceTimeoutMs = 10 * 60_000
const ports = {
    available: desktopSubscriptionDeviceLoginAvailable,
    approved: desktopSubscriptionDeviceApproved,
    create: createDesktopSubscriptionDeviceAttempt,
    forget: forgetDesktopSubscriptionDeviceApproval,
    relay: openDesktopSubscriptionDeviceRelay,
}

interface Pending {
    abort: AbortController
    done: Promise<void>
    status: DesktopSubscriptionLoginStatus
}

export function bindDesktopSubscriptionDeviceLogin(io: typeof ports = ports, timeoutMs = deviceTimeoutMs) {
    const running = new Map<DesktopSubscriptionProvider, Pending>()
    const settled = new Map<DesktopSubscriptionProvider, DesktopSubscriptionLoginStatus>()
    let closed = false

    function status(provider: DesktopSubscriptionProvider): DesktopSubscriptionLoginStatus {
        if (!io.available(provider)) return { phase: 'unavailable' }
        return running.get(provider)?.status ?? settled.get(provider) ??
            (io.approved(provider) ? { phase: 'approved' } : { phase: 'idle' })
    }

    function snapshot(): DesktopSubscriptionLoginSnapshot {
        return { 'grok-build': status('grok-build'), 'kimi-code': status('kimi-code') }
    }

    async function run(provider: DesktopSubscriptionProvider, entry: Pending) {
        const { signal } = entry.abort
        let relay: Awaited<ReturnType<typeof io.relay>> | undefined
        let attempt: ReturnType<typeof io.create> | undefined
        let worker: ReturnType<NonNullable<typeof attempt>['launch']> | undefined
        let result: DesktopSubscriptionLoginStatus = { phase: 'error', reason: 'failed' }
        let expired = false
        let saved = false
        const timer = setTimeout(() => { expired = true; entry.abort.abort() }, timeoutMs)
        timer.unref()
        try {
            attempt = io.create(provider, randomUUID())
            relay = await io.relay(provider)
            signal.throwIfAborted()
            worker = attempt.launch(relay.proxy, relay.port)
            worker.child.stdin.on('error', () => {})
            worker.child.stdin.end()
            worker.child.stdout.resume()
            worker.child.stderr.on('data', desktopSubscriptionDeviceOutput(provider, challenge => {
                if (!signal.aborted) entry.status = { phase: 'waiting', ...challenge }
            }))
            const cancelled = new Promise<null>(resolve => signal.addEventListener('abort', () => resolve(null), { once: true }))
            const exit = await Promise.race([once(worker.child, 'close'), cancelled])
            if (exit?.[0] === 0 && entry.status.phase === 'waiting' && !signal.aborted) {
                await relay.close()
                await worker.dispose()
                signal.throwIfAborted()
                attempt.approve()
                saved = true
                result = { phase: 'approved' }
            }
        } catch {
            // Never return provider output, which can include credentials or local paths.
        } finally {
            clearTimeout(timer)
            try {
                await relay?.close()
                await worker?.dispose()
                if (!saved) attempt?.discard()
                if (signal.aborted) result = expired ? { phase: 'error', reason: 'expired' } : { phase: 'idle' }
            } catch {
                result = { phase: 'error', reason: 'unconfirmed' }
            }
            if (saved) settled.delete(provider)
            else settled.set(provider, result)
            running.delete(provider)
        }
    }

    async function cancelPending() {
        const active = [...running.values()]
        for (const entry of active) {
            entry.status = { phase: 'cancelling' }
            entry.abort.abort()
        }
        await Promise.all(active.map(entry => entry.done))
    }

    return {
        snapshot,
        cancelPending,
        async action({ provider, action }: DesktopSubscriptionLoginAction) {
            const active = running.get(provider)
            const previous = settled.get(provider)
            const canRetry = previous?.phase !== 'error' || previous.reason !== 'unconfirmed'
            if (action === 'start' && !closed && !active && canRetry && io.available(provider) && !io.approved(provider)) {
                const entry: Pending = {
                    abort: new AbortController(), status: { phase: 'starting' }, done: Promise.resolve(),
                }
                running.set(provider, entry)
                entry.done = run(provider, entry)
            }
            if (action === 'cancel' || action === 'disconnect') {
                if (active) {
                    active.status = { phase: 'cancelling' }
                    active.abort.abort()
                    await active.done
                }
                if (action === 'disconnect' && !closed && io.available(provider)) {
                    io.forget(provider)
                    settled.delete(provider)
                }
            }
            return snapshot()
        },
        async close() {
            closed = true
            await cancelPending()
        },
    }
}

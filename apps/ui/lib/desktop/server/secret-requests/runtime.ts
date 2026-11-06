import 'server-only'
import { sameDesktopSecretRequestSource, type DesktopSecretRequestInput, type DesktopSecretRequestSource } from '@rerun/contracts'
import { DesktopHttpError } from '../auth'
import type { DesktopSecretRequestApiPorts } from './api'
import { createDesktopSecretRequestContinuation, type DesktopSecretContinuationPorts } from './service'
import type { DesktopSecretRequestAuthority, DesktopSecretRequestStore } from './store'

export type DesktopSecretRequestRuntimePorts = {
    store: DesktopSecretRequestStore
    source: (sessionId: string, signal: AbortSignal) => Promise<(DesktopSecretRequestInput & { source: DesktopSecretRequestSource; requestedAt?: string | null }) | null>
    authority: (sessionId: string, source: DesktopSecretRequestSource, mode: 'decision' | 'replay') => DesktopSecretRequestAuthority
    recovery?: (sessionId: string, signal: AbortSignal) => Promise<import('@rerun/contracts').DesktopSecretRequestView | null>
    send: DesktopSecretContinuationPorts['send']
}

export function createDesktopSecretRequestRuntimePorts(ports: DesktopSecretRequestRuntimePorts): DesktopSecretRequestApiPorts {
    const continuation = createDesktopSecretRequestContinuation(ports.store, { send: ports.send })
    const authority = (sessionId: string, expected: DesktopSecretRequestSource, mode: 'decision' | 'replay', signal: AbortSignal): DesktopSecretRequestAuthority => {
        const current = ports.authority(sessionId, expected, mode)
        return { assertCurrent: () => { signal.throwIfAborted(); current.assertCurrent?.() }, check: async () => {
            signal.throwIfAborted()
            await current.check()
            if (mode === 'decision') {
                const pending = await ports.source(sessionId, signal)
                if (!pending || !sameDesktopSecretRequestSource(pending.source, expected)) throw new DesktopHttpError(409, 'This credential request is no longer the current request.')
            }
            signal.throwIfAborted()
            await current.check()
            signal.throwIfAborted()
        } }
    }
    return {
        async read(sessionId, signal) {
            const source = await ports.source(sessionId, signal)
            if (!source) return ports.recovery?.(sessionId, signal) ?? null
            if (source.source.sessionId !== sessionId) throw new DesktopHttpError(409, 'Credential request owner changed.')
            await authority(sessionId, source.source, 'replay', signal).check()
            return ports.store.preview(source)
        },
        async decide(sessionId, input, signal) {
            if (input.source.sessionId !== sessionId) throw new DesktopHttpError(409, 'Credential request owner changed.')
            const existing = await ports.store.read(input.requestId)
            if (!existing) {
                const pending = await ports.source(sessionId, signal)
                if (!pending || !sameDesktopSecretRequestSource(pending.source, input.source)) throw new DesktopHttpError(409, 'This credential request is no longer current.')
                await ports.store.publish(pending, authority(sessionId, input.source, 'decision', signal))
            }
            return continuation.decide(input, authority(sessionId, input.source, existing?.receipt ? 'replay' : 'decision', signal), authority(sessionId, input.source, 'replay', signal))
        },
        async recover(sessionId, input, signal) {
            if (input.source.sessionId !== sessionId) throw new DesktopHttpError(409, 'Credential request owner changed.')
            const existing = await ports.store.read(input.requestId)
            if (!existing || existing.revision !== input.expectedRevision || !sameDesktopSecretRequestSource(existing.source, input.source)) {
                throw new DesktopHttpError(409, 'This saved decision belongs to another credential request.')
            }
            const mode = existing.receipt ? 'replay' : 'decision'
            return continuation.recover(input, authority(sessionId, input.source, mode, signal), authority(sessionId, input.source, 'replay', signal))
        },
    }
}

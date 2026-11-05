import 'server-only'
import type { DesktopSecretRequestInput, DesktopSecretRequestSource } from '../../../../../../packages/contracts/src/desktop-secret-requests'
import type { DesktopSecretRequestApiPorts } from './api'
import { createDesktopSecretRequestContinuation, type DesktopSecretContinuationPorts } from './service'
import type { DesktopSecretRequestAuthority, DesktopSecretRequestStore } from './store'

export type DesktopSecretRequestRuntimePorts = {
    store: DesktopSecretRequestStore
    source: (sessionId: string, signal: AbortSignal) => Promise<(DesktopSecretRequestInput & { source: DesktopSecretRequestSource }) | null>
    authority: (sessionId: string) => DesktopSecretRequestAuthority
    send: DesktopSecretContinuationPorts['send']
}

export function createDesktopSecretRequestRuntimePorts(ports: DesktopSecretRequestRuntimePorts): DesktopSecretRequestApiPorts {
    const continuation = createDesktopSecretRequestContinuation(ports.store, { send: ports.send })
    const authority = (sessionId: string, signal: AbortSignal): DesktopSecretRequestAuthority => {
        const current = ports.authority(sessionId)
        return { check: () => { signal.throwIfAborted(); current.check() } }
    }
    return {
        async read(sessionId, signal) {
            const source = await ports.source(sessionId, signal)
            if (!source) return null
            return ports.store.publish(source)
        },
        async decide(sessionId, input, signal) {
            if (input.source.sessionId !== sessionId) throw new Error('Credential request owner changed')
            return continuation.decide(input, authority(sessionId, signal))
        },
    }
}

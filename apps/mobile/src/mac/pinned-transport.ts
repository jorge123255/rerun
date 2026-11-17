import type { MacReplyFrame, PinnedFetch, PinnedStream } from '@rerun/mac-pairing-client'
import { requireOptionalNativeModule } from 'expo'
import { randomUUID } from 'expo-crypto'

type Subscription = { remove(): void }

type MacPairingTransportModule = {
    request(id: string, url: string, pin: string, method: string, headers: Record<string, string>, body: string | null, timeoutMs: number): Promise<{ status: number; body: string }>
    openStream(id: string, url: string, pin: string, headers: Record<string, string>): Promise<void>
    cancel(id: string): Promise<void>
    addListener(event: 'onStreamLine', listener: (event: { id: string; line: string }) => void): Subscription
    addListener(event: 'onStreamEnd', listener: (event: { id: string; status: number; error?: string | null }) => void): Subscription
}

const REQUEST_TIMEOUT_MS = 10_000

// Only in a binary built with it (modules/mac-pairing-transport): null in Expo Go and in the tests,
// where a Mac on the local network cannot be reached at all.
const Native = requireOptionalNativeModule<MacPairingTransportModule>('MacPairingTransport')

export const pinnedTransportAvailable = Native !== null

export class MacTransportError extends Error {
    constructor(
        message: string,
        readonly status = 0
    ) {
        super(message)
        this.name = 'MacTransportError'
    }
}

export function parseReplyFrame(line: string): MacReplyFrame | null {
    try {
        const frame = JSON.parse(line) as { reset?: unknown; delta?: unknown }
        if (frame.reset === true) return { reset: true }
        return typeof frame.delta === 'string' ? { delta: frame.delta } : null
    } catch {
        return null
    }
}

export function createPinnedTransport(native: MacPairingTransportModule | null = Native): { pinnedFetch?: PinnedFetch; pinnedStream?: PinnedStream } {
    if (!native) return {}

    const pinnedFetch: PinnedFetch = async (url, fingerprint, options) => {
        const id = randomUUID()
        const cancel = () => void native.cancel(id).catch(() => {})
        if (options.signal.aborted) throw new MacTransportError('aborted')
        options.signal.addEventListener('abort', cancel, { once: true })
        try {
            const { status, body } = await native.request(id, url, fingerprint, options.method, options.headers, options.body ?? null, REQUEST_TIMEOUT_MS)
            return { ok: status >= 200 && status < 300, status, json: async () => JSON.parse(body) as unknown }
        } finally {
            options.signal.removeEventListener('abort', cancel)
        }
    }

    const pinnedStream: PinnedStream = (url, pin, authorization, onFrame, signal) =>
        new Promise<void>((resolve, reject) => {
            if (signal?.aborted) return resolve()
            const id = randomUUID()
            const cancel = () => void native.cancel(id).catch(() => {})
            const lines = native.addListener('onStreamLine', event => {
                if (event.id !== id) return
                const frame = parseReplyFrame(event.line)
                if (frame) onFrame(frame)
            })
            const end = native.addListener('onStreamEnd', event => {
                if (event.id !== id) return
                lines.remove()
                end.remove()
                signal?.removeEventListener('abort', cancel)
                // 204: the reply is already over. A stream cut by the person leaving is not a failure either.
                if (signal?.aborted || event.status === 200 || event.status === 204) return resolve()
                reject(new MacTransportError(event.error ?? 'request_failed', event.status))
            })
            signal?.addEventListener('abort', cancel, { once: true })
            native.openStream(id, url, pin, { Accept: 'application/x-ndjson', Authorization: authorization }).catch(error => {
                lines.remove()
                end.remove()
                signal?.removeEventListener('abort', cancel)
                reject(error instanceof Error ? error : new MacTransportError('request_failed'))
            })
        })

    return { pinnedFetch, pinnedStream }
}

import type { DesktopMcpSseFailure } from '../../../../../../packages/contracts/src/desktop-mcp-sse'

const messages: Record<DesktopMcpSseFailure, string> = {
    'auth-needed': 'Sign-in needed. Use this server’s existing authentication flow.',
    unsupported: 'This server uses an unsupported legacy SSE protocol or endpoint.',
    unavailable: 'The SSE server is unavailable. Reconnect explicitly before another call.',
    'invalid-data': 'The SSE server returned malformed or oversized data.',
    changed: 'The coworker, server revision, credential or run changed. Reload the connection.',
    timeout: 'The SSE operation exceeded its bounded deadline.',
    cancelled: 'The SSE operation was cancelled. A dispatched tool may still have run.',
    'close-unconfirmed': 'Connection close is not confirmed. Retry disconnect before replacing it.',
}
export class SseFailure extends Error {
    constructor(readonly code: DesktopMcpSseFailure) { super(messages[code]); this.name = 'SseFailure' }
}
export function safeFailure(error: unknown): SseFailure { return error instanceof SseFailure ? error : new SseFailure('unavailable') }
export function deferred<T>() {
    let resolve!: (value: T) => void, reject!: (error: unknown) => void
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
    void promise.catch(() => {})
    return { promise, resolve, reject }
}
export function wait<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
    return new Promise((resolve, reject) => {
        const abort = () => { signal.removeEventListener('abort', abort); reject(new SseFailure(signal.reason instanceof DOMException && signal.reason.name === 'TimeoutError' ? 'timeout' : 'cancelled')) }
        work.then(value => { signal.removeEventListener('abort', abort); if (signal.aborted) abort(); else resolve(value) }, error => { signal.removeEventListener('abort', abort); reject(error) })
        if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true })
    })
}

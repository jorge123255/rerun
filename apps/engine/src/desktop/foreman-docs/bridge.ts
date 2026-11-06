import { z } from 'zod'
import {
    DESKTOP_FOREMAN_DOCS_LIMITS,
    desktopForemanDocsResultSchema,
    type DesktopForemanDocsRequest,
} from '@rerun/contracts'
import type { ForemanRuntime } from '../foreman/bridge.js'

export function createDesktopForemanDocsBridge(runtime: ForemanRuntime, network: typeof fetch = fetch) {
    const origin = new URL(runtime.app.origin)
    if (origin.protocol !== 'http:' || origin.hostname !== '127.0.0.1' || !origin.port || origin.origin !== runtime.app.origin || !/^[a-f0-9]{64}$/.test(runtime.engine.apiKey) || !z.uuid().safeParse(runtime.launchNonce).success) throw new Error('Desktop Foreman documentation callback is unavailable.')
    const closed = new AbortController()

    async function search(input: DesktopForemanDocsRequest, stop?: AbortSignal) {
        const signal = AbortSignal.any([closed.signal, ...(stop ? [stop] : []), AbortSignal.timeout(DESKTOP_FOREMAN_DOCS_LIMITS.bridgeTimeoutMs)])
        signal.throwIfAborted()
        const body = JSON.stringify({ action: 'search_docs', launchNonce: runtime.launchNonce, ...input })
        if (Buffer.byteLength(body) > DESKTOP_FOREMAN_DOCS_LIMITS.maxRequestBytes) throw new Error('Foreman documentation request exceeds limit.')
        const response = await network(`${origin.origin}/api/desktop/internal/foreman-docs`, {
            method: 'POST',
            headers: { authorization: `Bearer ${runtime.engine.apiKey}`, 'content-type': 'application/json' },
            body,
            signal,
            redirect: 'error',
            credentials: 'omit',
        })
        const reader = response.body?.getReader()
        if (!reader) throw new Error('Foreman documentation acknowledgement unavailable.')
        const chunks: Uint8Array[] = []
        let length = 0
        const cancel = () => { void reader.cancel().catch(() => {}) }
        signal.addEventListener('abort', cancel, { once: true })
        try {
            while (true) {
                signal.throwIfAborted()
                const next = await reader.read()
                signal.throwIfAborted()
                if (next.done) break
                length += next.value.byteLength
                if (length > DESKTOP_FOREMAN_DOCS_LIMITS.maxResponseBytes) throw new Error('Foreman documentation response exceeds limit.')
                chunks.push(next.value)
            }
            if (!response.ok) throw new Error('The documentation search is unavailable or no longer current.')
            return desktopForemanDocsResultSchema.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')))
        } finally {
            signal.removeEventListener('abort', cancel)
            void reader.cancel().catch(() => {})
        }
    }

    return { search, close() { closed.abort() } }
}

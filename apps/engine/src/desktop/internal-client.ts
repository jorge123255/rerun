import { env } from '../config/env.js'
import { abortable } from './web-fetch/transport.js'

/** Authenticated loopback callback to the existing desktop UI runtime. Never accepts a model-selected host. */
export async function desktopInternalJson(path: string, body: unknown, signal: AbortSignal, maxBytes = 1_100_000): Promise<unknown> {
    if (!/^\/api\/desktop\/internal\/[a-z0-9/-]+$/.test(path)) throw new Error('Invalid desktop callback')
    const config = env(), url = new URL(config.RERUN_HUB_BASE_URL ?? '')
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.pathname !== '/' || url.search || url.hash || url.username || url.password || !config.RERUN_API_KEY) throw new Error('The desktop service is unavailable')
    const encoded = JSON.stringify(body)
    if (Buffer.byteLength(encoded) > 200_000) throw new Error('Desktop request exceeds its limit')
    signal.throwIfAborted()
    const response = await fetch(url.origin + path, { method: 'POST', headers: { Authorization: `Bearer ${config.RERUN_API_KEY}`, 'Content-Type': 'application/json' }, body: encoded, signal, redirect: 'error', credentials: 'omit' })
    const reader = response.body?.getReader()
    if (!reader) throw new Error('Desktop service returned no result')
    const chunks: Uint8Array[] = []; let size = 0
    const cancel = () => { void reader.cancel().catch(() => {}) }
    signal.addEventListener('abort', cancel, { once: true })
    try {
        while (true) {
            const next = await abortable(reader.read(), signal)
            signal.throwIfAborted()
            if (next.done) break
            size += next.value.byteLength
            if (size > maxBytes) throw new Error('Desktop response exceeds its limit')
            chunks.push(next.value)
        }
        if (!response.ok) throw new Error('This desktop tool is unavailable for the current run.')
        return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
    } finally {
        signal.removeEventListener('abort', cancel)
        await abortable(reader.cancel(), AbortSignal.timeout(1_000)).catch(() => {})
    }
}

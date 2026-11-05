import { selfMcpProposeResultSchema, type SelfMcpProposeResult, type SelfMcpRunIdentity } from '@rerun/contracts'
import { env } from '../../config/env.js'

// The engine -> UI propose bridge, mirroring `desktop/mcp-tools.ts`: same
// loopback callback origin, same Bearer auth with `RERUN_API_KEY`, same bounded
// request/response and abortable reader. Proposing a server is the only effect
// the tool may trigger, and it is a review reservation only: the UI side opens
// no network connection and changes no configuration here.

const MAX_PROPOSE_BYTES = 96_000
const MAX_RESPONSE_BYTES = 1_100_000

function callbackUrl(): string {
    const base = env().RERUN_HUB_BASE_URL
    if (!base) throw new Error('The desktop MCP review service is unavailable')
    const url = new URL(base)
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.pathname !== '/' || url.search || url.hash || url.username || url.password)
        throw new Error('The desktop MCP review service is unavailable')
    return `${url.origin}/api/desktop/internal/self-mcp`
}

function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
    return new Promise((resolve, reject) => {
        const cancel = () => { signal.removeEventListener('abort', cancel); reject(signal.reason ?? new Error('Self-MCP proposal cancelled')) }
        signal.addEventListener('abort', cancel, { once: true })
        work.then(value => { signal.removeEventListener('abort', cancel); if (signal.aborted) cancel(); else resolve(value) }, error => { signal.removeEventListener('abort', cancel); reject(error) })
        if (signal.aborted) cancel()
    })
}

export async function proposeSelfMcp(
    identity: SelfMcpRunIdentity,
    fingerprint: string,
    input: unknown,
    stop: AbortSignal | undefined,
    timeout = 15_000,
): Promise<SelfMcpProposeResult> {
    const signal = AbortSignal.any([...(stop ? [stop] : []), AbortSignal.timeout(timeout)])
    signal.throwIfAborted()
    const apiKey = env().RERUN_API_KEY
    if (!apiKey) throw new Error('The desktop MCP review service is unavailable')
    const serialized = JSON.stringify({ action: 'propose', identity, fingerprint, input })
    if (Buffer.byteLength(serialized) > MAX_PROPOSE_BYTES) throw new Error('MCP proposal exceeds limit')
    const response = await fetch(callbackUrl(), { method: 'POST', headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: serialized, signal, redirect: 'error', credentials: 'omit' })
    const reader = response.body?.getReader()
    if (!reader) throw new Error('MCP review service returned no result')
    const chunks: Uint8Array[] = []; let size = 0
    const cancel = () => { void reader.cancel().catch(() => {}) }
    signal.addEventListener('abort', cancel, { once: true })
    try {
        while (true) {
            const next = await abortable(reader.read(), signal)
            signal.throwIfAborted()
            if (next.done) break
            size += next.value.byteLength
            if (size > MAX_RESPONSE_BYTES) throw new Error('MCP review response exceeds limit')
            chunks.push(next.value)
        }
        if (!response.ok) throw new Error('MCP proposal failed. Check this coworker’s permission and connection.')
        return selfMcpProposeResultSchema.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')))
    } finally {
        signal.removeEventListener('abort', cancel)
        await abortable(reader.cancel(), AbortSignal.timeout(1_000)).catch(() => {})
    }
}

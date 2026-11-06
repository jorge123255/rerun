import { desktopMcpSignInServerSchema, type DesktopMcpSignInRequestInput } from '@rerun/contracts'
import { env } from '../../config/env.js'
export async function resolveDesktopMcpSignInServer(identity: { engineAgentId: string; sessionId: string; runId: string }, input: DesktopMcpSignInRequestInput, stop?: AbortSignal) {
    const config = env(), url = new URL(config.RERUN_HUB_BASE_URL ?? 'about:blank')
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.pathname !== '/' || url.search || url.hash || url.username || url.password || !config.RERUN_API_KEY) throw new Error('Desktop MCP sign-in is unavailable.')
    const signal = AbortSignal.any([...(stop ? [stop] : []), AbortSignal.timeout(15_000)])
    const response = await fetch(`${url.origin}/api/desktop/internal/mcp-sign-in`, { method: 'POST', headers: { Authorization: `Bearer ${config.RERUN_API_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ identity, input }), signal, redirect: 'error', credentials: 'omit' })
    const reader = response.body?.getReader()
    if (!reader) throw new Error('MCP registration unavailable.')
    const chunks: Uint8Array[] = []; let size = 0
    const cancel = () => { void reader.cancel().catch(() => {}) }
    signal.addEventListener('abort', cancel, { once: true })
    try {
        while (true) { signal.throwIfAborted(); const next = await reader.read(); signal.throwIfAborted(); if (next.done) break; size += next.value.byteLength; if (size > 16_384) throw new Error('MCP registration response too large.'); chunks.push(next.value) }
        if (!response.ok) throw new Error('This registered MCP server does not support desktop sign-in.')
        return desktopMcpSignInServerSchema.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')))
    } finally { signal.removeEventListener('abort', cancel); void reader.cancel().catch(() => {}) }
}

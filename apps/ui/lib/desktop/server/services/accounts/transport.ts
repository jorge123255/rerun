import 'server-only'

import { abortable, boundedText, decodeReply } from '../../mcp/remote'
import { endpoint, type RemoteTool } from '../../mcp/model'
import { DESKTOP_SERVICE_ACCOUNT_MESSAGES as M } from '@rerun/contracts'

export type AccountNetwork = (url: string, init: RequestInit) => Promise<Response>

export type AccountTransportProbe = {
    url: string
    headers: Record<string, string>
    signal: AbortSignal
    secretValues?: string[]
    guard?: () => Promise<void>
}

export interface AccountTransportPort {
    probe(input: AccountTransportProbe): Promise<{ tools: RemoteTool[] }>
    call(input: AccountTransportProbe & { name: string; arguments: Record<string, unknown> }): Promise<{ result: Record<string, unknown> }>
}

const LIMIT = 1024 * 1024

function redact(value: unknown, secrets: string[]): unknown {
    const hidden = secrets.filter(secret => secret.length > 0)
    const apply = (item: unknown): unknown => {
        if (typeof item === 'string') return hidden.reduce((text, secret) => text.split(secret).join('[REDACTED]'), item)
        if (Array.isArray(item)) return item.map(apply)
        if (item && typeof item === 'object') return Object.fromEntries(Object.entries(item).map(([key, nested]) => [apply(key), apply(nested)]))
        return item
    }
    return apply(value)
}

function failed(): never {
    throw new Error(M.origin)
}

/**
 * One account, one exact HTTPS URL. Redirects are not followed, so a header
 * set cannot be sent to another origin. Credentials are omitted.
 */
export function accountTransport(network: AccountNetwork): AccountTransportPort {
    async function session(input: AccountTransportProbe, call?: { name: string; arguments: Record<string, unknown> }) {
        const url = endpoint(input.url)
        if (url !== input.url) failed()
        const signal = input.signal
        const secrets = [...Object.values(input.headers), ...(input.secretValues ?? [])]
        let sessionId = ''
        let rpcId = 0
        const headers = () => ({
            ...input.headers,
            'Content-Type': 'application/json',
            Accept: 'application/json, text/event-stream',
            'MCP-Protocol-Version': '2025-03-26',
            ...(sessionId ? { 'Mcp-Session-Id': sessionId } : {}),
        })
        async function rpc(method: string, params: unknown, notification = false) {
            signal.throwIfAborted()
            await input.guard?.()
            signal.throwIfAborted()
            const requestId = ++rpcId
            const body = JSON.stringify({ jsonrpc: '2.0', ...(notification ? {} : { id: requestId }), method, params })
            if (Buffer.byteLength(body) > 65536) failed()
            const response = await network(url, { method: 'POST', redirect: 'manual', credentials: 'omit', signal, headers: headers(), body })
            if (response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400)) {
                if (response.body) await response.body.cancel().catch(() => {})
                failed()
            }
            if (!response.ok) {
                if (response.body) await response.body.cancel().catch(() => {})
                failed()
            }
            const nextSession = response.headers.get('mcp-session-id')
            if (nextSession) {
                if (!/^[\x21-\x7e]{1,1024}$/.test(nextSession)) failed()
                sessionId = nextSession
            }
            if (notification && response.status === 202) {
                if (response.body) await response.body.cancel().catch(() => {})
                return {}
            }
            const mime = response.headers.get('content-type')?.split(';')[0]?.trim()
            if (mime !== 'application/json' && mime !== 'text/event-stream') {
                if (response.body) await response.body.cancel().catch(() => {})
                failed()
            }
            const raw = await boundedText(response, signal, LIMIT, mime === 'text/event-stream' ? requestId : undefined)
            await input.guard?.()
            signal.throwIfAborted()
            return redact(decodeReply(raw, mime ?? 'application/json', requestId), secrets) as Record<string, unknown>
        }
        try {
            const init = await rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'rerun-desktop', version: '1.0.0' } })
            if (init.protocolVersion !== '2025-03-26') failed()
            await rpc('notifications/initialized', {}, true)
            if (call) {
                const result = await rpc('tools/call', call)
                if (!Array.isArray(result.content)) failed()
                return { result }
            }
            const tools: RemoteTool[] = []
            let cursor: string | undefined
            for (let page = 0; page < 8; page++) {
                const result = await rpc('tools/list', cursor ? { cursor } : {})
                if (!Array.isArray(result.tools)) failed()
                for (const tool of result.tools) {
                    if (!tool || typeof tool !== 'object') failed()
                    const row = tool as { name?: unknown; description?: unknown; inputSchema?: { type?: unknown } }
                    if (typeof row.name !== 'string' || !/^[\w.-]{1,128}$/.test(row.name) || !row.inputSchema || row.inputSchema.type !== 'object' || tools.some(item => item.name === row.name)) failed()
                    tools.push({ name: row.name, description: typeof row.description === 'string' ? row.description.slice(0, 8000) : undefined, inputSchema: row.inputSchema as RemoteTool['inputSchema'] })
                }
                if (tools.length > 256 || Buffer.byteLength(JSON.stringify(tools)) > LIMIT) failed()
                const next = result.nextCursor
                if (!next) break
                if (typeof next !== 'string' || next.length > 4096 || page === 7) failed()
                cursor = next
            }
            return { tools }
        } catch (error) {
            if (error instanceof Error && error.message === M.origin) throw error
            throw new Error(signal.aborted ? M.cancelled : M.origin)
        } finally {
            if (sessionId && !signal.aborted) {
                const cleanup = AbortSignal.any([signal, AbortSignal.timeout(1000)])
                try {
                    await input.guard?.()
                    const closed = await abortable(network(url, { method: 'DELETE', redirect: 'manual', credentials: 'omit', signal: cleanup, headers: headers() }), cleanup)
                    if (closed.type === 'opaqueredirect' || (closed.status >= 300 && closed.status < 400)) {
                        if (closed.body) await closed.body.cancel().catch(() => {})
                    } else if (closed.body) await closed.body.cancel().catch(() => {})
                } catch {
                    /* Never log server errors or credentials. */
                }
            }
            sessionId = ''
        }
    }
    return {
        async probe(input) {
            const result = await session(input)
            if (!result.tools) failed()
            return { tools: result.tools }
        },
        async call(input) {
            const result = await session(input, { name: input.name, arguments: input.arguments })
            if (!result.result) failed()
            return { result: result.result }
        },
    }
}

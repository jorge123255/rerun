import { endpoint } from '../mcp/model'
import { DESKTOP_MCP_SSE_LIMITS as L } from '@rerun/contracts'
import { SseFailure } from './errors'

export function advertisedSseEndpoint(approved: string, advertised: string): { url: string; sessionValues: string[] } {
    try {
        const base = new URL(endpoint(approved))
        if (!advertised || advertised.length > L.endpointChars || /[\u0000-\u0020\u007f\\]/.test(advertised)) throw new Error()
        const target = new URL(advertised, base)
        if (target.protocol !== 'https:' || target.origin !== base.origin || target.username || target.password || target.hash) throw new Error()
        const values: string[] = [], names = new Set<string>()
        for (const [key, value] of target.searchParams) {
            if (!['sessionId', 'session_id'].includes(key) || names.size || names.has(key) || !/^[A-Za-z0-9_-]{16,256}$/.test(value)) throw new Error()
            names.add(key); values.push(value)
        }
        return { url: target.href, sessionValues: values }
    } catch { throw new SseFailure('unsupported') }
}
export function sseEndpointDisplay(approved: string) { return new URL(endpoint(approved)).origin }

import { EXTERNAL_MCP_COPY, EXTERNAL_MCP_PATH, type ExternalMcpRefusal } from '@rerun/contracts'

export type ExternalMcpHttpCheck = {
    host: string | null
    origin: string | null
    path: string
    search: string
    remoteAddress: string | undefined
    boundHost: string
}

export function externalMcpBearer(header: string | null): string | null {
    if (!header?.startsWith('Bearer ')) return null
    const token = header.slice('Bearer '.length)
    if (!token || /\s/.test(token)) return null
    return token
}

/** Loopback, exact Host, no Origin, no query or userinfo. No CORS header is set by the caller. */
export function externalMcpHttpRefusal(input: ExternalMcpHttpCheck): ExternalMcpRefusal | null {
    const remote = input.remoteAddress
    if (remote !== '127.0.0.1' && remote !== '::ffff:127.0.0.1') {
        return { ok: false, code: 'forbidden_host', message: EXTERNAL_MCP_COPY.unauthorized }
    }
    if (input.search || input.path !== EXTERNAL_MCP_PATH) {
        return { ok: false, code: 'forbidden_url', message: 'The external MCP address does not accept a token or another path.' }
    }
    if (!input.host || input.host.toLowerCase() !== input.boundHost.toLowerCase()) {
        return { ok: false, code: 'forbidden_host', message: 'This listener only answers its loopback host.' }
    }
    if (input.origin) {
        return { ok: false, code: 'forbidden_origin', message: 'This listener does not accept a browser origin.' }
    }
    return null
}

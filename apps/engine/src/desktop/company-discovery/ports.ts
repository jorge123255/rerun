// Injected ports. Tests never open a socket. The confined adapters are the only production readers.

export type PublicRead =
    | { ok: true; url: string; status: number; contentType: string; body: string; bytes: number }
    | { ok: false; reason: 'failed' | 'timeout' | 'blocked' | 'malformed' | 'oversized' | 'private' | 'cancelled' }

export type PublicPageReader = (url: string, signal: AbortSignal, accept: 'html' | 'json') => Promise<PublicRead>

export type DnsRecords = { mx: string[]; txt: string[]; dmarc: string[] }

export type DnsLookupResult = { ok: true; records: DnsRecords } | { ok: false; reason: 'failed' | 'timeout' | 'blocked' | 'private' | 'cancelled' }

export type DnsLookup = (domain: string, signal: AbortSignal) => Promise<DnsLookupResult>

export type PublicFailure = Exclude<Extract<PublicRead, { ok: false }>['reason'], never>

export function classifyPublicFailure(error: unknown, parent: AbortSignal): PublicFailure {
    if (parent.aborted) return 'cancelled'
    const message = error instanceof Error ? error.message : ''
    if (/byte limit/i.test(message)) return 'oversized'
    if (/public host|public addresses|Not a public|credentials|Only HTTP/i.test(message)) return 'private'
    if (/content type|could not be read|Redirect limit|Invalid URL/i.test(message)) return 'malformed'
    if (/timeout|Deadline|timed out|aborted/i.test(message)) return 'timeout'
    return 'failed'
}

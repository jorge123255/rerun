import { RELAY_PROTOCOL } from './protocol.ts'

// The Mac proves it holds this install's secret with every connection:
//   X-Rerun-Relay-Auth: v1.<unix seconds>.<nonce>.<signature>
// where signature = base64url(HMAC-SHA256(secret, signingInput)). The timestamp bounds how long a
// captured header is worth anything, and the Durable Object refuses a nonce it has already seen.
export const RELAY_AUTH_HEADER = 'x-rerun-relay-auth'
const HEADER = /^v1\.(\d{1,12})\.([A-Za-z0-9_-]{22,43})\.([A-Za-z0-9_-]{43})$/
export const SECRET = /^[A-Za-z0-9_-]{43}$/
export const INSTALL_ID = /^[A-Za-z0-9_-]{43}$/

export function relaySigningInput(installId: string, host: string, path: string, timestamp: number, nonce: string): string {
    return [RELAY_PROTOCOL, installId, host.toLowerCase(), path, String(timestamp), nonce].join('\n')
}

export function base64UrlBytes(value: string): Uint8Array<ArrayBuffer> {
    const binary = atob(value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (value.length % 4)) % 4))
    const bytes = new Uint8Array(binary.length)
    for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index)
    return bytes
}

export type RelayAuthVerdict = { ok: true; timestamp: number; nonce: string } | { ok: false }

export async function verifyRelayAuth(input: {
    secret: string; installId: string; host: string; path: string; header: string | null; nowSeconds: number; windowSeconds: number
}): Promise<RelayAuthVerdict> {
    const parsed = HEADER.exec(input.header ?? '')
    if (!parsed || !SECRET.test(input.secret)) return { ok: false }
    const timestamp = Number(parsed[1]), nonce = parsed[2]
    if (Math.abs(input.nowSeconds - timestamp) > input.windowSeconds) return { ok: false }
    const key = await crypto.subtle.importKey('raw', base64UrlBytes(input.secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify'])
    // HMAC verification in WebCrypto compares in constant time.
    const valid = await crypto.subtle.verify('HMAC', key, base64UrlBytes(parsed[3]),
        new TextEncoder().encode(relaySigningInput(input.installId, input.host, input.path, timestamp, nonce)))
    return valid ? { ok: true, timestamp, nonce } : { ok: false }
}

/** `RELAY_INSTALLS` is a JSON object of per-install id to that install's secret. Malformed entries do not exist. */
export function installSecret(installs: string | undefined, installId: string): string | null {
    if (!INSTALL_ID.test(installId) || !installs) return null
    let parsed: unknown
    try { parsed = JSON.parse(installs) } catch { return null }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !Object.hasOwn(parsed, installId)) return null
    const secret = (parsed as Record<string, unknown>)[installId]
    return typeof secret === 'string' && SECRET.test(secret) ? secret : null
}

import 'server-only'
import { createHash, createHmac, timingSafeEqual } from 'node:crypto'

// ElevenLabs signs the token it sends with every Speech Engine connection with HS256, keyed by the
// SHA-256 of the account's API key. These are the checks of their SDK's verifySpeechEngineJwt, with
// the algorithm pinned and the signature compared in constant time.
export const SPEECH_ENGINE_ISSUER = 'https://api.elevenlabs.io/convai/speech-engine'
export const SPEECH_ENGINE_SUBJECT = 'convai_speech_engine_upstream'
const LEEWAY_SECONDS = 60
// A data-residency key (sk_..._residency_eu) signs with its base key.
const RESIDENCY_SUFFIX = /_residency_[a-z0-9]+$/

export type SpeechEngineTokenVerdict = 'ok' | 'missing' | 'malformed' | 'signature' | 'claims' | 'expired' | 'early'

function json(part: string): Record<string, unknown> | null {
    try {
        const value = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'))
        return value && typeof value === 'object' && !Array.isArray(value) ? value : null
    } catch { return null }
}

export function verifySpeechEngineToken(value: string | null | undefined, apiKey: string, nowSeconds = Math.floor(Date.now() / 1000)): SpeechEngineTokenVerdict {
    if (!value) return 'missing'
    let token = value.trim()
    if (token.toLowerCase().startsWith('bearer ')) token = token.slice(7).trim()
    const parts = token.split('.')
    if (parts.length !== 3 || parts.some(part => !/^[A-Za-z0-9_-]+$/.test(part))) return 'malformed'
    const header = json(parts[0]), payload = json(parts[1])
    if (!header || !payload || header.alg !== 'HS256') return 'malformed'
    const secret = createHash('sha256').update(apiKey.trim().replace(RESIDENCY_SUFFIX, ''), 'utf8').digest()
    const expected = createHmac('sha256', secret).update(`${parts[0]}.${parts[1]}`).digest()
    const presented = Buffer.from(parts[2], 'base64url')
    secret.fill(0)
    if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) return 'signature'
    if (payload.iss !== SPEECH_ENGINE_ISSUER || payload.sub !== SPEECH_ENGINE_SUBJECT || typeof payload.exp !== 'number' || typeof payload.iat !== 'number') return 'claims'
    if (payload.exp + LEEWAY_SECONDS < nowSeconds) return 'expired'
    if (payload.iat - LEEWAY_SECONDS > nowSeconds) return 'early'
    return 'ok'
}

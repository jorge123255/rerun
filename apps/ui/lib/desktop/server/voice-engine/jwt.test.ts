import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { verifySpeechEngineToken } from './jwt'
import { API_KEY, OTHER_KEY, signSpeechEngineToken } from './voice.test-support'

const now = () => Math.floor(Date.now() / 1000)

describe('the token ElevenLabs sends with each connection', () => {
    it('is accepted when signed with the SHA-256 of this Mac\'s key, with the right issuer and subject', () => {
        const token = signSpeechEngineToken(API_KEY)
        expect(verifySpeechEngineToken(token, API_KEY)).toBe('ok')
        expect(verifySpeechEngineToken(`Bearer ${token}`, API_KEY)).toBe('ok')
    })

    it('is refused when missing, malformed, or signed with another key', () => {
        expect(verifySpeechEngineToken(undefined, API_KEY)).toBe('missing')
        expect(verifySpeechEngineToken('', API_KEY)).toBe('missing')
        expect(verifySpeechEngineToken('a.b', API_KEY)).toBe('malformed')
        expect(verifySpeechEngineToken('a.b.c!', API_KEY)).toBe('malformed')
        expect(verifySpeechEngineToken(signSpeechEngineToken(OTHER_KEY), API_KEY)).toBe('signature')
        const token = signSpeechEngineToken(API_KEY)
        expect(verifySpeechEngineToken(token.slice(0, -2) + (token.endsWith('AA') ? 'BB' : 'AA'), API_KEY)).toBe('signature')
        // Signed with the key itself rather than its hash.
        const [header, payload] = token.split('.')
        const raw = `${header}.${payload}.${createHmac('sha256', API_KEY).update(`${header}.${payload}`).digest('base64url')}`
        expect(verifySpeechEngineToken(raw, API_KEY)).toBe('signature')
    })

    it('is refused when expired beyond the 60 second leeway, or issued in the future', () => {
        expect(verifySpeechEngineToken(signSpeechEngineToken(API_KEY, { iat: now() - 300, exp: now() - 61 }), API_KEY)).toBe('expired')
        expect(verifySpeechEngineToken(signSpeechEngineToken(API_KEY, { iat: now() - 300, exp: now() - 30 }), API_KEY)).toBe('ok')
        expect(verifySpeechEngineToken(signSpeechEngineToken(API_KEY, { iat: now() + 120, exp: now() + 180 }), API_KEY)).toBe('early')
    })

    it('is refused with the wrong claims or any algorithm but HS256', () => {
        expect(verifySpeechEngineToken(signSpeechEngineToken(API_KEY, { iss: 'https://example.com' }), API_KEY)).toBe('claims')
        expect(verifySpeechEngineToken(signSpeechEngineToken(API_KEY, { sub: 'someone' }), API_KEY)).toBe('claims')
        expect(verifySpeechEngineToken(signSpeechEngineToken(API_KEY, { exp: undefined }), API_KEY)).toBe('claims')
        expect(verifySpeechEngineToken(signSpeechEngineToken(API_KEY, { iat: 'yesterday' }), API_KEY)).toBe('claims')
        expect(verifySpeechEngineToken(signSpeechEngineToken(API_KEY, {}, { alg: 'none' }), API_KEY)).toBe('malformed')
        expect(verifySpeechEngineToken(signSpeechEngineToken(API_KEY, {}, { alg: 'HS512' }), API_KEY)).toBe('malformed')
    })

    it('uses the base key of a data-residency key', () => {
        expect(verifySpeechEngineToken(signSpeechEngineToken(API_KEY), `${API_KEY}_residency_eu`)).toBe('ok')
    })
})

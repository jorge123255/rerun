import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { relayAuthHeader, relayMacUrl, relaySigningInput, relaySpeechEngineUrl } from './relay-protocol'

// The same vector as cloud-voice-relay/test/relay.test.ts: the Worker verifies what this signs.
const SECRET = 'cmVsYXktc2VjcmV0LWZvci10aGUtdmVjdG9yLTMyYnk'

describe('the Mac\'s signature on its relay connection', () => {
    it('matches the fixed vector the relay is tested against', () => {
        const input = relaySigningInput('install-id-for-vector', 'Relay.Example.Test', '/v1/install-id-for-vector/mac', 1_790_000_000, 'bm9uY2Utbm9uY2Utbm9uY2U')
        expect(input).toBe('rerun-voice-relay-v1\ninstall-id-for-vector\nrelay.example.test\n/v1/install-id-for-vector/mac\n1790000000\nbm9uY2Utbm9uY2Utbm9uY2U')
        expect(createHmac('sha256', Buffer.from(SECRET, 'base64url')).update(input).digest('base64url')).toBe('TjJ--vQwYwm-LQQ0AiS3iJ1XXjWz3zvhHjcvFDq6Q8U')
        const header = relayAuthHeader({ secret: SECRET, installId: 'install-id-for-vector', url: new URL('wss://relay.example.test/v1/install-id-for-vector/mac'), nowMs: 1_790_000_000_400, nonce: 'bm9uY2Utbm9uY2Utbm9uY2U' })
        expect(header).toBe('v1.1790000000.bm9uY2Utbm9uY2Utbm9uY2U.TjJ--vQwYwm-LQQ0AiS3iJ1XXjWz3zvhHjcvFDq6Q8U')
    })

    it('uses a fresh nonce each time and never carries the secret', () => {
        const url = new URL('wss://relay.example.test/v1/id/mac')
        const first = relayAuthHeader({ secret: SECRET, installId: 'id', url, nowMs: Date.now() })
        const second = relayAuthHeader({ secret: SECRET, installId: 'id', url, nowMs: Date.now() })
        expect(first).not.toBe(second)
        expect(first).not.toContain(SECRET)
    })

    it('derives the two relay paths from the address and the install id', () => {
        expect(relayMacUrl('https://voice.example.com', 'abc').toString()).toBe('wss://voice.example.com/v1/abc/mac')
        expect(relaySpeechEngineUrl('https://voice.example.com', 'abc')).toBe('wss://voice.example.com/v1/abc/speech-engine')
    })
})

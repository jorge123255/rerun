import { describe, expect, it } from 'vitest'
import { buildDesktopTriggerMessage, redactTriggerSecrets } from './message.js'

describe('buildDesktopTriggerMessage', () => {
    it('formats payload like original and never embeds secrets', () => {
        const { message, truncated } = buildDesktopTriggerMessage(
            { slug: 'hook', body: 'Do the thing.' },
            { token: 'SECRET', method: 'POST', query: 'a=1', contentType: 'application/json', body: '{"x":1}', bodyBytes: 7 },
            '2026-11-05T12:00:00.000Z',
        )
        expect(truncated).toBe(false)
        expect(message).toContain('<trigger_payload')
        expect(message).toContain('Do the thing.')
        expect(message).not.toContain('SECRET')
        expect(redactTriggerSecrets('Authorization: Bearer SECRET and Cookie: a=b', ['SECRET'])).toContain('[redacted]')
    })
})

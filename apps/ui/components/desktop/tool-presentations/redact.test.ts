import { describe, expect, it } from 'vitest'
import { redactHistoricalText } from './redact'

const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJmaXh0dXJlIn0.c2lnbmF0dXJlLWZpeHR1cmU'

describe('redactHistoricalText', () => {
    it('removes key shapes wherever they stand', () => {
        for (const secret of [
            'sk-fixture0000000000', 'rk_fixture0000000000', 'xai-fixture0000000000', 'ghp_fixture0000000000',
            'github_pat_fixture0000000000', 'glpat-fixture0000000000', 'xoxb-fixture-0000000000', 'AKIAFIXTURE000000000', jwt,
        ]) {
            const out = redactHistoricalText(`ran with ${secret} and finished`)
            expect(out, secret).toBe('ran with [redacted] and finished')
        }
    })

    it('removes credential headers, assignments, bearer values and URL sign-ins', () => {
        expect(redactHistoricalText('x-api-key: abc123\nAccept: text/plain')).toBe('x-api-key: [redacted]\nAccept: text/plain')
        expect(redactHistoricalText('Proxy-Authorization: Basic Zml4dHVyZQ==')).toBe('Proxy-Authorization: [redacted]')
        expect(redactHistoricalText('Cookie: session=1; other=2')).toBe('Cookie: [redacted]')
        expect(redactHistoricalText('curl -H "Authorization: Bearer abc.def" https://user:pw@example.test/x'))
            .toBe('curl -H "Authorization: [redacted]')
        expect(redactHistoricalText('fetch with Bearer abc123, then stop')).toBe('fetch with Bearer [redacted], then stop')
        expect(redactHistoricalText('API_KEY=abc123 npm test')).toBe('API_KEY=[redacted] npm test')
        expect(redactHistoricalText('open https://user:pw@example.test/x')).toBe('open https://[redacted]@example.test/x')
    })

    it('leaves ordinary text, paths and short look-alikes alone', () => {
        for (const text of ['Read apps/ui/lib/tool-meta.ts', 'risk_score went up', 'eyJ is how a token starts', 'task-sk-12', 'the tokenizer split 4 words']) {
            expect(redactHistoricalText(text)).toBe(text)
        }
    })

    it('redacts before it cuts, so a cut never leaves part of a secret', () => {
        const out = redactHistoricalText(`${'a'.repeat(190)} sk-fixture0000000000`, 200)
        expect(out).not.toContain('sk-fix')
        expect(out.length).toBeLessThanOrEqual(201)
    })
})

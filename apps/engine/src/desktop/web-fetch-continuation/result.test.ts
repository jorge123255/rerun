import { describe, expect, it } from 'vitest'
import { webFetchContinuationNote } from './continuation'

describe('truncated result continuation notice', () => {
    it('preserves the honest no-full-copy state when no publisher is bound', () => {
        expect(webFetchContinuationNote(true, null)).toBe('\n[Output truncated to 50000 characters; no full copy saved.]')
        expect(webFetchContinuationNote(false, null)).toBe('')
    })

    it('distinguishes a saved full page from an unconfirmed save', () => {
        expect(webFetchContinuationNote(true, { saved: true, path: '.rerun/pages/example.served.html.txt' })).toContain('Saved whole: .rerun/pages/example.served.html.txt')
        expect(webFetchContinuationNote(true, { saved: false, reason: 'revoked' })).toBe('\n[Output truncated to 50000 characters; full copy not confirmed: revoked.]')
    })
})

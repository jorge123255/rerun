import { describe, expect, it } from 'vitest'
import type { DesktopWebSearchOutcome } from '@rerun/contracts'
import { desktopWebSearchActivityOf, desktopWebSearchCapabilityMessage, desktopWebSearchHistoryOutcome, desktopWebSearchResultView, desktopWebSearchSourceMetadata } from './web-search'

const success: DesktopWebSearchOutcome = {
    status: 'success', provenance: { provider: 'fixture-search' },
    results: [{ title: 'One', url: 'https://one.example/', snippet: 'first' }],
}

describe('desktop web search adapters', () => {
    it('keeps activity text and provider-ordered source metadata separate from assistant citations', () => {
        expect(desktopWebSearchActivityOf({ query: 'rerun', maxResults: 5 })).toBe('Searching rerun')
        expect(desktopWebSearchSourceMetadata(success)).toEqual([{ title: 'One', url: 'https://one.example/', snippet: 'first', provenance: { provider: 'fixture-search' } }])
        expect(desktopWebSearchSourceMetadata({ status: 'unavailable', message: 'Off' })).toEqual([])
    })

    it('parses saved outcomes without turning unavailable data into results', () => {
        expect(desktopWebSearchHistoryOutcome(success)).toEqual(success)
        expect(desktopWebSearchHistoryOutcome({ status: 'success', results: 'not-an-array' })).toBeNull()
        expect(desktopWebSearchResultView({ status: 'unavailable', message: 'Off' })).toEqual({ kind: 'error', message: 'Search failed: Off' })
    })

    it('returns No results only for a successful empty outcome', () => {
        expect(desktopWebSearchResultView({ status: 'success', provenance: { provider: 'fixture-search' }, results: [] })).toEqual({ kind: 'empty', message: 'No results.' })
    })

    it('uses secret-free readiness text and adds retry guidance only when allowed', () => {
        expect(desktopWebSearchCapabilityMessage({ status: 'ready', message: 'Ready.', retryable: false })).toBe('Ready.')
        expect(desktopWebSearchCapabilityMessage({ status: 'unavailable', message: 'Unavailable.', retryable: true })).toBe('Unavailable. Check the search capability, then retry.')
        expect(desktopWebSearchCapabilityMessage({ status: 'unconfigured', message: 'Not configured.', retryable: false })).toBe('Not configured.')
    })
})

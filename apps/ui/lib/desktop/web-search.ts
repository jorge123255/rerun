import {
    desktopWebSearchInputSchema,
    desktopWebSearchOutcomeSchema,
    type DesktopWebSearchCapabilityView,
    type DesktopWebSearchOutcome,
    type DesktopWebSearchProvenance,
    type DesktopWebSearchResult,
} from '@rerun/contracts'

export type DesktopWebSearchSourceMetadata = DesktopWebSearchResult & { provenance: DesktopWebSearchProvenance }

export function desktopWebSearchActivityOf(input: unknown): string {
    const parsed = desktopWebSearchInputSchema.safeParse(input)
    return parsed.success ? `Searching ${parsed.data.query}` : 'Searching'
}

export function desktopWebSearchHistoryOutcome(input: unknown): DesktopWebSearchOutcome | null {
    const parsed = desktopWebSearchOutcomeSchema.safeParse(input)
    return parsed.success ? parsed.data : null
}

export function desktopWebSearchSourceMetadata(outcome: DesktopWebSearchOutcome): DesktopWebSearchSourceMetadata[] {
    return outcome.status === 'success' ? outcome.results.map(result => ({ ...result, provenance: outcome.provenance })) : []
}

export type DesktopWebSearchResultView =
    | { kind: 'empty'; message: 'No results.' }
    | { kind: 'error'; message: string }
    | { kind: 'results'; results: DesktopWebSearchResult[]; provenance: DesktopWebSearchProvenance }

export function desktopWebSearchResultView(outcome: DesktopWebSearchOutcome): DesktopWebSearchResultView {
    if (outcome.status !== 'success') return { kind: 'error', message: `Search failed: ${outcome.message}` }
    if (outcome.results.length === 0) return { kind: 'empty', message: 'No results.' }
    return { kind: 'results', results: outcome.results, provenance: outcome.provenance }
}

export function desktopWebSearchCapabilityMessage(view: DesktopWebSearchCapabilityView): string {
    if (view.status === 'ready') return view.message
    return view.retryable ? `${view.message} Check the search capability, then retry.` : view.message
}

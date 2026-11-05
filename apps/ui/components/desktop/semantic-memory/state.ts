import type { DesktopSemanticRecallResult } from '../../../../../packages/contracts/src/desktop-semantic-memory.ts'

// Recall state only. Drafts and the unfiltered note list stay in the memories panel.
export type SemanticMemoryPanelState = {
    ownerId: string
    query: string
    ticket: number
    phase: 'idle' | 'loading' | 'ready' | 'error'
    result: DesktopSemanticRecallResult | null
    error: string
}

export type SemanticMemoryPanelEvent =
    | { type: 'owner'; ownerId: string; ticket: number }
    | { type: 'query'; query: string; ticket: number }
    | { type: 'start'; ticket: number; ownerId: string; query: string }
    | { type: 'success'; ticket: number; ownerId: string; query: string; result: DesktopSemanticRecallResult }
    | { type: 'failure'; ticket: number; ownerId: string; query: string; error: string }

export function semanticMemoryPanelState(ownerId: string): SemanticMemoryPanelState {
    return { ownerId, query: '', ticket: 0, phase: 'idle', result: null, error: '' }
}

function current(state: SemanticMemoryPanelState, event: { ticket: number; ownerId: string; query: string }): boolean {
    return event.ticket === state.ticket && event.ownerId === state.ownerId && event.query === state.query
}

export function reduceSemanticMemoryPanel(state: SemanticMemoryPanelState, event: SemanticMemoryPanelEvent): SemanticMemoryPanelState {
    if (event.type === 'owner') {
        if (event.ownerId === state.ownerId && event.ticket === state.ticket) return state
        return { ownerId: event.ownerId, query: '', ticket: event.ticket, phase: 'idle', result: null, error: '' }
    }
    if (event.type === 'query') {
        if (event.query === state.query && event.ticket === state.ticket) return state
        return { ...state, query: event.query, ticket: event.ticket, phase: 'idle', result: null, error: '' }
    }
    if (!current(state, event)) return state
    if (event.type === 'start') return { ...state, phase: 'loading', error: '' }
    if (event.type === 'success') return { ...state, phase: 'ready', result: event.result, error: '' }
    return { ...state, phase: 'error', error: event.error }
}

// Original memories panel: "Searching…" and `N recalled for "<query>"`.
export function semanticMemoryStatusCopy(searching: boolean, query: string, count: number): string {
    if (searching) return 'Searching memories…'
    return `${count} recalled for "${query}"`
}

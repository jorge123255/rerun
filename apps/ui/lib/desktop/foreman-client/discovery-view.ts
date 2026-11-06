/** Trusted discovery projection — aligns with I's DesktopForemanDiscoveryEvent / Finding. */

import {
    DESKTOP_FOREMAN_SOURCE_LABELS,
    type DesktopDiscoverySource,
    type DesktopForemanFinding,
    type DesktopForemanDiscoveryEvent,
} from '@rerun/contracts'
export type { DesktopDiscoverySource }
export type DesktopDiscoveryFinding = DesktopForemanFinding
export type DesktopDiscoveryAttribution = DesktopForemanFinding['attribution']
export type DesktopDiscoveryEvent = DesktopForemanDiscoveryEvent

export type DesktopDiscoveryEntry =
    | { id: string; order: number; source: DesktopDiscoverySource; type: 'teaser' }
    | { id: string; order: number; source: DesktopDiscoverySource; type: 'finding'; finding: DesktopDiscoveryFinding; arrival: number }
    | { id: string; order: number; source: DesktopDiscoverySource; type: 'unavailable' }

export type DesktopDiscoveriesState = {
    entries: DesktopDiscoveryEntry[]
    nextOrder: number
    arrivals: number
    ended: boolean
    error: string | null
    loading: boolean
    unavailable: DesktopDiscoverySource[]
}

export const EMPTY_DESKTOP_DISCOVERIES: DesktopDiscoveriesState = {
    entries: [],
    nextOrder: 0,
    arrivals: 0,
    ended: false,
    error: null,
    loading: false,
    unavailable: [],
}

export const DESKTOP_DISCOVERY_SOURCE_LABELS = DESKTOP_FOREMAN_SOURCE_LABELS

export const DESKTOP_DISCOVERY_TEASERS: Record<DesktopDiscoverySource, (subject: { name: string; domain: string }) => string> = {
    profile: ({ domain }) => `Reading ${domain}…`,
    stack: ({ domain }) => `Peeking under the hood of ${domain}…`,
    dns: () => 'Checking how you run email…',
    registry: () => 'Looking you up in the public registry…',
    site: ({ domain }) => `Reading every page of ${domain}…`,
    search: ({ name }) => `Searching the web for ${name}…`,
    linkedinPerson: () => 'Looking for you on LinkedIn…',
    linkedinCompany: ({ name }) => `Finding ${name} on LinkedIn…`,
    googleBusiness: () => 'Reading your Google reviews…',
    catalog: ({ domain }) => `Browsing the ${domain} shop…`,
    synthesis: () => 'Piecing it all together…',
}

const teaserId = (source: DesktopDiscoverySource) => `teaser:${source}`
const findingId = (finding: DesktopDiscoveryFinding) => `finding:${finding.kind}`

export function applyDesktopDiscoveryEvent(state: DesktopDiscoveriesState, event: DesktopDiscoveryEvent): DesktopDiscoveriesState {
    if (event.type === 'end') {
        return { ...state, ended: true, loading: false, entries: state.entries.filter(entry => entry.type !== 'teaser') }
    }
    if (event.type === 'pending') {
        if (state.entries.some(entry => entry.source === event.source)) return { ...state, ended: false, loading: true, error: null }
        return {
            ...state,
            ended: false,
            loading: true,
            error: null,
            nextOrder: state.nextOrder + 1,
            entries: [...state.entries, { id: teaserId(event.source), order: state.nextOrder, source: event.source, type: 'teaser' }],
        }
    }
    if (event.type === 'unavailable') {
        const teaser = state.entries.find(entry => entry.id === teaserId(event.source))
        const entries = state.entries.filter(entry => entry !== teaser)
        return {
            ...state,
            loading: entries.some(entry => entry.type === 'teaser'),
            unavailable: state.unavailable.includes(event.source) ? state.unavailable : [...state.unavailable, event.source],
            nextOrder: state.nextOrder + 1,
            entries: [
                ...entries,
                { id: `unavailable:${event.source}`, order: teaser?.order ?? state.nextOrder, source: event.source, type: 'unavailable' },
            ],
        }
    }

    const teaser = state.entries.find(entry => entry.id === teaserId(event.source))
    let entries = state.entries.filter(entry => entry !== teaser)
    if (event.type === 'dropped') return { ...state, entries, loading: entries.some(entry => entry.type === 'teaser') }

    let arrivals = state.arrivals
    let nextOrder = state.nextOrder
    for (const finding of event.findings) {
        const id = findingId(finding)
        const existing = entries.findIndex(entry => entry.id === id)
        arrivals += 1
        const row: DesktopDiscoveryEntry = {
            id,
            order: existing >= 0 ? entries[existing].order : teaser?.order ?? nextOrder++,
            source: event.source,
            type: 'finding',
            finding,
            arrival: arrivals,
        }
        entries = existing >= 0 ? entries.map((entry, index) => (index === existing ? row : entry)) : [...entries, row]
    }
    return { ...state, entries, arrivals, nextOrder, loading: entries.some(entry => entry.type === 'teaser'), error: null, ended: false }
}

/** Project I's discovery run row into overlay state (pending/unavailable/findings). */
export function discoveriesFromRun(run: {
    status: 'running' | 'done' | 'failed' | 'stopped'
    pending: DesktopDiscoverySource[]
    unavailable: DesktopDiscoverySource[]
    findings: DesktopDiscoveryFinding[]
} | null): DesktopDiscoveriesState {
    if (!run) return EMPTY_DESKTOP_DISCOVERIES
    let state = { ...EMPTY_DESKTOP_DISCOVERIES, loading: run.status === 'running', ended: run.status !== 'running' }
    for (const source of run.pending) state = applyDesktopDiscoveryEvent(state, { type: 'pending', source })
    for (const source of run.unavailable) state = applyDesktopDiscoveryEvent(state, { type: 'unavailable', source })
    const bySource = new Map<DesktopDiscoverySource, DesktopDiscoveryFinding[]>()
    for (const finding of run.findings) {
        const list = bySource.get(finding.source) ?? []
        list.push(finding)
        bySource.set(finding.source, list)
    }
    for (const [source, findings] of bySource) state = applyDesktopDiscoveryEvent(state, { type: 'found', source, findings })
    if (run.status !== 'running') state = applyDesktopDiscoveryEvent(state, { type: 'end' })
    if (run.status === 'failed') state = { ...state, error: 'Discovery failed.' }
    return state
}

export function projectDiscoveriesOverlay(state: DesktopDiscoveriesState, domain: string): {
    empty: boolean
    loading: boolean
    error: string | null
    subject: { name: string; domain: string }
    entries: DesktopDiscoveryEntry[]
} {
    const identity = state.entries.find(
        (entry): entry is Extract<DesktopDiscoveryEntry, { type: 'finding' }> =>
            entry.type === 'finding' && entry.finding.kind === 'identity',
    )
    const name = identity && identity.finding.kind === 'identity' ? identity.finding.name : domain
    return {
        empty: state.entries.length === 0 && !state.loading && !state.error,
        loading: state.loading,
        error: state.error,
        subject: { name, domain },
        entries: [...state.entries].sort((a, b) => a.order - b.order),
    }
}

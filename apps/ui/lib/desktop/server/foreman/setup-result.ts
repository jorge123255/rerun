export const SETUP_CONNECTION_STATUSES = ['pending', 'failed', 'connected', 'skipped'] as const
export type SetupConnectionStatus = (typeof SETUP_CONNECTION_STATUSES)[number]
export type SetupPermissions = Record<string, boolean>
export type SetupOffer = { slug: string; name: string; adds: string }
export type SetupRequiredAction = { name: string; kind: 'credential' | 'permission' }
export type SetupConnection = { slug: string; name: string; adds: string; role: 'improving'; status: SetupConnectionStatus }
export type SetupGate = { name: string; kind: 'credential' | 'permission'; status: 'pending' | 'failed' | 'granted' }
export type SetupResultState = { version: 1; connections: SetupConnection[]; gate: SetupGate | null; permissions: SetupPermissions }
export type SetupWork = { continue: boolean; delivery: 'public-or-labeled-sample' | 'gated'; sampleLabel: 'sample'; blockedBy: string | null }
export type SetupDecision = { slug: string; status: Exclude<SetupConnectionStatus, 'pending'> } | { gate: 'granted' | 'failed' }

const STATUSES = new Set<string>(SETUP_CONNECTION_STATUSES)
const record = (value: unknown): Record<string, unknown> | null => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null

export function permissionsOf(value: unknown): SetupPermissions {
    const source = record(value)
    if (!source) return {}
    const permissions: SetupPermissions = {}
    for (const [key, entry] of Object.entries(source)) if (typeof entry === 'boolean') permissions[key] = entry
    return permissions
}

function resolvePermissions(saved: SetupPermissions, live?: SetupPermissions): SetupPermissions {
    if (!live) return { ...saved }
    const permissions: SetupPermissions = {}
    for (const [key, value] of Object.entries(live)) if (typeof value === 'boolean') permissions[key] = value === true && saved[key] === true
    return permissions
}

export function openSetupResult(input: { offers?: readonly SetupOffer[]; required?: SetupRequiredAction | null; permissions?: SetupPermissions } = {}): SetupResultState {
    return {
        version: 1,
        connections: (input.offers ?? []).map(offer => ({ slug: offer.slug, name: offer.name, adds: offer.adds, role: 'improving' as const, status: 'pending' as const })),
        gate: input.required ? { name: input.required.name, kind: input.required.kind, status: 'pending' } : null,
        permissions: permissionsOf(input.permissions),
    }
}

export function decideSetupConnection(state: SetupResultState, decision: SetupDecision): SetupResultState {
    const next = resumeSetupResult(state)
    if ('gate' in decision) {
        if (next.gate) next.gate = { ...next.gate, status: decision.gate }
        return next
    }
    const connection = next.connections.find(item => item.slug === decision.slug)
    if (connection) connection.status = decision.status
    return next
}

export function workWithinScope(state: SetupResultState): SetupWork {
    if (state.gate && state.gate.status !== 'granted') return { continue: false, delivery: 'gated', sampleLabel: 'sample', blockedBy: state.gate.name }
    return { continue: true, delivery: 'public-or-labeled-sample', sampleLabel: 'sample', blockedBy: null }
}

function connectionStatus(value: unknown): SetupConnectionStatus {
    return typeof value === 'string' && STATUSES.has(value) ? value as SetupConnectionStatus : 'pending'
}

function gateOf(value: unknown): SetupGate | null {
    const gate = record(value)
    if (!gate || (gate.kind !== 'credential' && gate.kind !== 'permission') || typeof gate.name !== 'string' || !gate.name) return null
    const status = gate.status === 'granted' || gate.status === 'failed' ? gate.status : 'pending'
    return { name: gate.name, kind: gate.kind, status }
}

function versioned(value: Record<string, unknown>, live?: SetupPermissions): SetupResultState | null {
    if (value.version !== 1 || !Array.isArray(value.connections)) return null
    const connections: SetupConnection[] = []
    for (const entry of value.connections) {
        const item = record(entry)
        if (!item || typeof item.slug !== 'string' || !item.slug) continue
        connections.push({
            slug: item.slug,
            name: typeof item.name === 'string' && item.name ? item.name : item.slug,
            adds: typeof item.adds === 'string' ? item.adds : '',
            role: 'improving',
            status: connectionStatus(item.status),
        })
    }
    return { version: 1, connections, gate: gateOf(value.gate), permissions: resolvePermissions(permissionsOf(value.permissions), live) }
}

function outcomeStatus(outcome: unknown, choice: unknown): SetupConnectionStatus {
    if (outcome === 'connected') return 'connected'
    if (outcome === 'reset' || outcome === 'not-found') return 'failed'
    if (outcome === 'skipped' || (choice === 'skip' && outcome == null)) return 'skipped'
    return 'pending'
}

function cardOf(value: Record<string, unknown>, live?: SetupPermissions): SetupResultState | null {
    const choices = Array.isArray(value.choices) ? value.choices : null
    const entries = Array.isArray(value.entries) ? value.entries : null
    if (!choices && !entries) return null
    const bySlug = new Map<string, { name: string; outcome?: unknown }>()
    for (const entry of entries ?? []) {
        const item = record(entry)
        if (!item || typeof item.slug !== 'string') continue
        bySlug.set(item.slug, { name: typeof item.name === 'string' ? item.name : item.slug, outcome: item.outcome })
    }
    const slugs = choices
        ? choices.flatMap(entry => { const item = record(entry); return item && typeof item.slug === 'string' ? [item.slug] : [] })
        : [...bySlug.keys()]
    const connections = slugs.map(slug => {
        const choice = choices?.map(record).find(item => item?.slug === slug)
        const known = bySlug.get(slug)
        return { slug, name: known?.name || slug, adds: '', role: 'improving' as const, status: outcomeStatus(known?.outcome, choice?.choice) }
    })
    return { version: 1, connections, gate: gateOf(value.requiredAction ?? value.gate), permissions: resolvePermissions(permissionsOf(value.permissions), live) }
}

export function resumeSetupResult(saved: unknown, live?: SetupPermissions): SetupResultState {
    const value = record(saved)
    if (!value) return openSetupResult({ permissions: live })
    return versioned(value, live) ?? cardOf(value, live) ?? openSetupResult({ permissions: resolvePermissions(permissionsOf(value.permissions), live) })
}

function mergeConnections(base: SetupConnection[], incoming: SetupConnection[]): SetupConnection[] {
    const incomingBySlug = new Map(incoming.map(item => [item.slug, item]))
    const merged = base.map(item => {
        const next = incomingBySlug.get(item.slug)
        if (item.status === 'pending' && next && next.status !== 'pending') return { ...item, status: next.status, name: next.name || item.name }
        return item
    })
    for (const item of incoming) if (!merged.some(current => current.slug === item.slug)) merged.push(item)
    return merged
}

export function projectSetupResult(input: { saved?: unknown; card?: unknown; permissions?: SetupPermissions }): SetupResultState {
    const base = input.saved == null ? openSetupResult({ permissions: input.permissions }) : resumeSetupResult(input.saved, input.permissions)
    const card = cardOf(record(input.card) ?? {}, input.permissions)
    if (!card) return base
    return { ...base, connections: mergeConnections(base.connections, card.connections), gate: base.gate ?? card.gate, permissions: base.permissions }
}

import type { CustomProviderModel, CustomProviderProbe } from '@rerun/contracts'
import { MODELS_ON_AT_CONNECT, normalizeBase, probeProblemMessage } from './messages'

export type ProbeTicket = {
    generation: number
    workspaceId: number
    connectionId: string
    revision: number
    baseUrl: string
}

export function sameProbe(ticket: ProbeTicket, current: ProbeTicket): boolean {
    return ticket.generation === current.generation
        && ticket.workspaceId === current.workspaceId
        && ticket.connectionId === current.connectionId
        && ticket.revision === current.revision
        && normalizeBase(ticket.baseUrl) === normalizeBase(current.baseUrl)
}

export type AppliedProbe = {
    apply: true
    selected: CustomProviderModel[]
    catalogModels: CustomProviderModel[] | null
    asksModel: boolean
    notice: string | null
}

function keepDefault(selected: CustomProviderModel[], previous: CustomProviderModel[], defaultModelId: string | null): CustomProviderModel[] {
    if (!defaultModelId || selected.some(model => model.id === defaultModelId)) return selected
    const keep = previous.find(model => model.id === defaultModelId)
    return keep ? [...selected, keep] : selected
}

/** A late or foreign probe is dropped. A missing list never becomes a discovered catalog or a disconnect. */
export function applyProbe(input: {
    ticket: ProbeTicket
    current: ProbeTicket
    probe: CustomProviderProbe
    selected: CustomProviderModel[]
    manualSeedId: string | null
    defaultModelId: string | null
}): { apply: false } | AppliedProbe {
    const { ticket, current, probe } = input
    if (!sameProbe(ticket, current)) return { apply: false }
    if (probe.identity.workspaceId !== ticket.workspaceId || probe.identity.connectionId !== ticket.connectionId || probe.identity.revision !== ticket.revision) return { apply: false }
    if (probe.problem === 'stale_revision' || probe.problem === 'cancelled') return { apply: false }
    const catalogModels = probe.status === 'fresh' ? probe.models.slice(0, 256) : probe.status === 'empty' ? [] : null
    let selected = input.selected
    const seed = input.manualSeedId
    if (probe.status === 'fresh' && probe.models.length > 0 && seed && selected.length === 1 && selected[0]?.id === seed) {
        const discovered = probe.models.slice(0, MODELS_ON_AT_CONNECT)
        const manual = selected[0]
        selected = discovered.some(model => model.id === manual.id) ? discovered : [...discovered, manual]
    }
    selected = keepDefault(selected, input.selected, input.defaultModelId)
    if (selected.length === 0) selected = input.selected
    return {
        apply: true,
        selected: selected.slice(0, 256),
        catalogModels,
        asksModel: probe.problem === 'not_listed',
        notice: probeProblemMessage(probe.problem, ticket.baseUrl, probe.manualModel),
    }
}

/** Draft discovery never becomes a saved catalog. A usable typed id is the only manual row. */
export function selectionFromDraftProbe(input: {
    status: CustomProviderProbe['status']
    models: CustomProviderModel[]
    problem: CustomProviderProbe['problem']
    manualModel: string | null
    manualUsable: boolean
}): { models: CustomProviderModel[] | null; asksModel: boolean } {
    const blocking = input.problem === 'unauthorized' || input.problem === 'unreachable' || input.problem === 'model_refused' || input.problem === 'policy_refused' || input.problem === 'unavailable' || input.problem === 'invalid' || input.problem === 'stale_revision' || input.problem === 'cancelled'
    if (blocking) return { models: null, asksModel: false }
    const typed = input.manualModel && input.manualUsable ? { id: input.manualModel, contextWindow: null, vision: false, source: 'manual' as const } : null
    if (input.status === 'fresh' && input.problem === null && input.models.length > 0) {
        const listed = input.models.slice(0, MODELS_ON_AT_CONNECT)
        if (!typed) return { models: listed, asksModel: false }
        const known = input.models.find(model => model.id === typed.id)
        const first = known ?? typed
        return { models: [first, ...listed.filter(model => model.id !== first.id)].slice(0, MODELS_ON_AT_CONNECT), asksModel: false }
    }
    if (typed && (input.problem === 'not_listed' || input.problem === null)) return { models: [typed], asksModel: input.problem === 'not_listed' }
    if (input.problem === 'not_listed' || input.status === 'empty') return { models: null, asksModel: true }
    return { models: null, asksModel: false }
}

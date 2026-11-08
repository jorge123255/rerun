import { createHash } from 'node:crypto'
import { DESKTOP_OPENCODE_CATALOG_STALE_MS, DESKTOP_OPENCODE_CATALOG_URL, DESKTOP_OPENCODE_PLANS, DESKTOP_OPENCODE_SNAPSHOT, parseDesktopOpencodeCatalog, type DesktopOpencodeModel, type DesktopOpencodePlan, type DesktopOpencodeRefresh } from '@rerun/contracts'

// Public catalog, scoped to the workspace that asked. A failed refresh keeps the last live reading,
// then the shipped snapshot. A snapshot is never reported as a fresh provider response.

const FETCH_TIMEOUT_MS = 10_000
type Reading = { models: DesktopOpencodeModel[]; at: number }
const readings = new Map<string, Reading>()
const attemptedAt = new Map<number, number>()

export class DesktopOpencodeCatalogError extends Error {
    constructor(readonly code: 'cancelled', message: string) {
        super(message)
        this.name = 'DesktopOpencodeCatalogError'
    }
}

const keyOf = (workspaceId: number, plan: DesktopOpencodePlan) => `${workspaceId}:${plan}`

export function resetDesktopOpencodeCatalogForTests(): void {
    readings.clear()
    attemptedAt.clear()
}

function revisionOf(models: readonly DesktopOpencodeModel[]): string {
    return createHash('sha256').update(JSON.stringify(models.map(model => [model.id, model.wire, model.baseUrl]))).digest('hex').slice(0, 32)
}

function modelsOf(workspaceId: number, plan: DesktopOpencodePlan): DesktopOpencodeModel[] {
    return readings.get(keyOf(workspaceId, plan))?.models ?? DESKTOP_OPENCODE_SNAPSHOT.filter(model => model.plan === plan)
}

export function desktopOpencodeListedModel(workspaceId: number, id: string): DesktopOpencodeModel | undefined {
    const plan = DESKTOP_OPENCODE_PLANS.find(item => id.startsWith(`${item}/`))
    if (!plan) return undefined
    return modelsOf(workspaceId, plan).find(model => model.id === id) ?? DESKTOP_OPENCODE_SNAPSHOT.find(model => model.id === id)
}

export function desktopOpencodeListedModels(workspaceId: number): DesktopOpencodeModel[] {
    return DESKTOP_OPENCODE_PLANS.flatMap(plan => modelsOf(workspaceId, plan))
}

export function desktopOpencodeContextWindow(workspaceId: number, id: string): number | null {
    return desktopOpencodeListedModel(workspaceId, id)?.contextWindow ?? null
}

// A live reading is the only list that can retire a model. Snapshot absence is not retirement.
export function desktopOpencodeDispatchModel(workspaceId: number, id: string): { kind: 'model'; model: DesktopOpencodeModel } | { kind: 'retired' } | { kind: 'missing' } {
    const plan = DESKTOP_OPENCODE_PLANS.find(item => id.startsWith(`${item}/`))
    if (!plan) return { kind: 'missing' }
    const reading = readings.get(keyOf(workspaceId, plan))
    if (reading) {
        const model = reading.models.find(item => item.id === id)
        return model ? { kind: 'model', model } : { kind: 'retired' }
    }
    const model = DESKTOP_OPENCODE_SNAPSHOT.find(item => item.id === id)
    return model ? { kind: 'model', model } : { kind: 'missing' }
}

function view(input: {
    workspaceId: number
    requestId: string
    selectedModelId: string
    enabledModelIds: readonly string[]
    source: DesktopOpencodeRefresh['source']
    fresh: boolean
    capturedAt: string | null
    unavailableReason?: string
}): DesktopOpencodeRefresh {
    const models = desktopOpencodeListedModels(input.workspaceId)
    const listed = new Set(models.map(model => model.id))
    const retiredModelIds = input.fresh ? input.enabledModelIds.filter(id => id.startsWith('go/') || id.startsWith('console/')).filter(id => !listed.has(id)) : []
    const selectedListed = listed.has(input.selectedModelId) || DESKTOP_OPENCODE_SNAPSHOT.some(model => model.id === input.selectedModelId)
    return {
        workspaceId: input.workspaceId,
        requestId: input.requestId,
        revision: input.fresh ? revisionOf(models) : revisionOf(input.source === 'snapshot' ? DESKTOP_OPENCODE_SNAPSHOT : models),
        source: input.source,
        fresh: input.fresh,
        capturedAt: input.capturedAt,
        unavailableReason: input.unavailableReason,
        selectedModelId: input.selectedModelId,
        selectedPreserved: input.fresh ? listed.has(input.selectedModelId) || retiredModelIds.includes(input.selectedModelId) : selectedListed,
        retiredModelIds,
        models,
    }
}

async function readPlan(plan: DesktopOpencodePlan, fetchImpl: typeof fetch, signal: AbortSignal, userAgent: string): Promise<DesktopOpencodeModel[] | null> {
    const response = await fetchImpl(DESKTOP_OPENCODE_CATALOG_URL[plan], { headers: { 'User-Agent': userAgent }, redirect: 'error', signal })
    if (!response.ok) return null
    const models = parseDesktopOpencodeCatalog(await response.json(), plan)
    return models.length ? models : null
}

export async function refreshDesktopOpencodeCatalog(input: {
    workspaceId: number
    requestId: string
    selectedModelId: string
    enabledModelIds?: readonly string[]
    fetch: typeof fetch
    signal?: AbortSignal
    now?: number
    userAgent?: string
}): Promise<DesktopOpencodeRefresh> {
    const now = input.now ?? Date.now()
    const signal = input.signal ?? AbortSignal.timeout(FETCH_TIMEOUT_MS)
    if (signal.aborted) throw new DesktopOpencodeCatalogError('cancelled', 'Catalog refresh was cancelled before it started.')
    attemptedAt.set(input.workspaceId, now)
    let live = 0
    let failed = false
    for (const plan of DESKTOP_OPENCODE_PLANS) {
        if (signal.aborted) throw new DesktopOpencodeCatalogError('cancelled', 'Catalog refresh was cancelled.')
        const models = await readPlan(plan, input.fetch, signal, input.userAgent ?? 'rerun-desktop-opencode/1').catch(() => null)
        if (!models) { failed = true; continue }
        readings.set(keyOf(input.workspaceId, plan), { models, at: now })
        live += 1
    }
    const enabled = input.enabledModelIds ?? []
    if (live === DESKTOP_OPENCODE_PLANS.length) {
        return view({ workspaceId: input.workspaceId, requestId: input.requestId, selectedModelId: input.selectedModelId, enabledModelIds: enabled, source: 'live', fresh: true, capturedAt: new Date(now).toISOString() })
    }
    const anyCached = DESKTOP_OPENCODE_PLANS.some(plan => readings.has(keyOf(input.workspaceId, plan)))
    return view({
        workspaceId: input.workspaceId,
        requestId: input.requestId,
        selectedModelId: input.selectedModelId,
        enabledModelIds: enabled,
        source: anyCached ? 'cached' : 'snapshot',
        fresh: false,
        capturedAt: anyCached ? new Date(now).toISOString() : null,
        unavailableReason: failed ? 'OpenCode catalog did not answer. The previous list is still shown.' : undefined,
    })
}

export function refreshStaleDesktopOpencodeCatalog(input: Parameters<typeof refreshDesktopOpencodeCatalog>[0]): Promise<DesktopOpencodeRefresh> | null {
    const now = input.now ?? Date.now()
    if (now - (attemptedAt.get(input.workspaceId) ?? 0) < DESKTOP_OPENCODE_CATALOG_STALE_MS) return null
    return refreshDesktopOpencodeCatalog(input)
}

export function desktopOpencodeCatalogView(input: { workspaceId: number; requestId: string; selectedModelId: string; enabledModelIds?: readonly string[] }): DesktopOpencodeRefresh {
    const anyCached = DESKTOP_OPENCODE_PLANS.some(plan => readings.has(keyOf(input.workspaceId, plan)))
    const both = DESKTOP_OPENCODE_PLANS.every(plan => readings.has(keyOf(input.workspaceId, plan)))
    return view({
        workspaceId: input.workspaceId,
        requestId: input.requestId,
        selectedModelId: input.selectedModelId,
        enabledModelIds: input.enabledModelIds ?? [],
        source: both ? 'cached' : anyCached ? 'cached' : 'snapshot',
        fresh: false,
        capturedAt: null,
    })
}

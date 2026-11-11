import { createHash } from 'node:crypto'
import { DESKTOP_OPENCODE_SNAPSHOT, desktopOpencodeDispatchSchema, desktopOpencodeEnableProblem, desktopOpencodeKeyProblem, desktopOpencodeRefreshSchema, desktopOpencodeResultSchema, type DesktopOpencodeDispatch, type DesktopOpencodeRefresh, type DesktopOpencodeResult, type DesktopOpencodeWindow } from '@rerun/contracts'
import { z } from 'zod'
import type { DesktopOpencodeAuthority, DesktopOpencodeAuthoritySnapshot } from './authority'
import { DesktopOpencodeStoreError, type DesktopOpencodeStore } from './store'

const promptSchema = z.strictObject({
    messages: z.unknown().optional(),
    contents: z.unknown().optional(),
    system: z.unknown().optional(),
    tools: z.unknown().optional(),
    maxOutputTokens: z.number().positive().optional(),
})

const scope = { workspaceId: z.number().int().positive().max(1_000_000), connectionId: z.string().min(1).max(200), requestId: z.string().min(1).max(200) }

export const desktopOpencodeRequestSchema = z.discriminatedUnion('action', [
    z.strictObject({ action: z.literal('prepare'), apiKey: z.string().max(4096) }),
    z.strictObject({ action: z.literal('catalog'), ...scope, selectedModelId: z.string().min(1).max(300) }),
    z.strictObject({ action: z.literal('refresh'), ...scope, selectedModelId: z.string().min(1).max(300) }),
    z.strictObject({ action: z.literal('usage'), ...scope, refresh: z.boolean().optional() }),
    z.strictObject({ action: z.literal('enable'), workspaceId: scope.workspaceId, connectionId: scope.connectionId, enabledModelIds: z.array(z.string()).max(256), defaultModelId: z.string().min(1).max(300), consoleEnabled: z.boolean() }),
    z.strictObject({ action: z.literal('disconnect'), workspaceId: scope.workspaceId, connectionId: scope.connectionId }),
    z.strictObject({ action: z.literal('execute'), dispatch: desktopOpencodeDispatchSchema, prompt: promptSchema.optional() }),
])
export type DesktopOpencodeRequest = z.infer<typeof desktopOpencodeRequestSchema>

export type DesktopOpencodePorts = {
    authority: DesktopOpencodeAuthority
    store: DesktopOpencodeStore
    execute?: (input: { dispatch: DesktopOpencodeDispatch; apiKey: string | null; prompt?: z.infer<typeof promptSchema>; signal?: AbortSignal; enabledModelIds: readonly string[] }) => Promise<DesktopOpencodeResult>
    refreshCatalog?: (input: { workspaceId: number; requestId: string; selectedModelId: string; enabledModelIds: readonly string[]; signal?: AbortSignal }) => Promise<DesktopOpencodeRefresh>
    refreshLimits?: (input: { workspaceId: number; connectionId: string; apiKey: string | null; signal?: AbortSignal }) => Promise<DesktopOpencodeWindow[] | null>
}

export class DesktopOpencodePublishError extends Error {
    constructor(readonly status: number, message: string) {
        super(message)
        this.name = 'DesktopOpencodePublishError'
    }
}

const unavailable = (message: string): DesktopOpencodeResult => desktopOpencodeResultSchema.parse({ status: 'refused', code: 'unavailable', message, sent: false })

function snapshotView(workspaceId: number, requestId: string, selectedModelId: string): DesktopOpencodeRefresh {
    return desktopOpencodeRefreshSchema.parse({
        workspaceId,
        requestId,
        revision: 'snapshot',
        source: 'snapshot',
        fresh: false,
        capturedAt: null,
        selectedModelId,
        selectedPreserved: DESKTOP_OPENCODE_SNAPSHOT.some(model => model.id === selectedModelId),
        retiredModelIds: [],
        models: DESKTOP_OPENCODE_SNAPSHOT,
    })
}

function digestOf(dispatch: DesktopOpencodeDispatch, prompt: unknown): string {
    return createHash('sha256').update(JSON.stringify({
        workspaceId: dispatch.workspaceId,
        connectionId: dispatch.connectionId,
        connectionRevision: dispatch.connectionRevision,
        consoleEnabled: dispatch.consoleEnabled,
        modelId: dispatch.modelId,
        purpose: dispatch.purpose,
        runId: dispatch.runId,
        sessionId: dispatch.sessionId,
        stream: dispatch.stream,
        prompt: prompt ?? null,
    })).digest('hex')
}

async function authorityOf(ports: DesktopOpencodePorts, workspaceId: number, connectionId: string, launchNonce: string, signal?: AbortSignal): Promise<DesktopOpencodeAuthoritySnapshot | DesktopOpencodeResult> {
    const snapshot = await ports.authority.current({ workspaceId, connectionId }, signal)
    if (!snapshot) return unavailable('OpenCode is not connected on this desktop.')
    if (snapshot.workspaceId !== workspaceId) return desktopOpencodeResultSchema.parse({ status: 'refused', code: 'workspace', message: 'OpenCode request belongs to another workspace.', sent: false })
    if (snapshot.launchNonce !== launchNonce) return desktopOpencodeResultSchema.parse({ status: 'refused', code: 'replaced', message: 'OpenCode launch no longer matches this desktop.', sent: false })
    if (snapshot.state === 'deleted' || snapshot.state === 'disabled') return unavailable('OpenCode is disconnected.')
    if (snapshot.state === 'replaced') return desktopOpencodeResultSchema.parse({ status: 'refused', code: 'replaced', message: 'OpenCode connection was replaced.', sent: false })
    return snapshot
}

// Receipts and display. Catalog reads and enable checks do not call execute.
export async function publishDesktopOpencode(ports: DesktopOpencodePorts, body: unknown, signal: AbortSignal | undefined, launchNonce: string): Promise<DesktopOpencodeResult | DesktopOpencodeRefresh | { ok: true } | { ok: false; problem: string } | { windows: DesktopOpencodeWindow[]; capturedAt: string | null; fresh: boolean }> {
    const request = desktopOpencodeRequestSchema.parse(body)
    if (request.action === 'prepare') {
        const problem = desktopOpencodeKeyProblem(request.apiKey)
        return problem ? { ok: false, problem } : { ok: true }
    }
    if (request.action === 'disconnect') {
        const snapshot = await ports.authority.current({ workspaceId: request.workspaceId, connectionId: request.connectionId }, signal)
        if (!snapshot) return unavailable('OpenCode is not connected on this desktop.')
        if (snapshot.workspaceId !== request.workspaceId) return desktopOpencodeResultSchema.parse({ status: 'refused', code: 'workspace', message: 'OpenCode request belongs to another workspace.', sent: false })
        await ports.store.forgetLimits(request.workspaceId, request.connectionId)
        return { ok: true }
    }
    if (request.action === 'catalog' || request.action === 'refresh') {
        const gate = await authorityOf(ports, request.workspaceId, request.connectionId, launchNonce, signal)
        if ('status' in gate) return gate
        if (request.action === 'catalog') {
            const stored = await ports.store.readCatalog(request.workspaceId)
            if (!stored) return snapshotView(request.workspaceId, request.requestId, request.selectedModelId || gate.defaultModelId)
            return { ...stored, fresh: false }
        }
        if (!ports.refreshCatalog) return unavailable('OpenCode catalog refresh is not mounted.')
        if (signal?.aborted) return desktopOpencodeResultSchema.parse({ status: 'refused', code: 'cancelled', message: 'Catalog refresh was cancelled before it started.', sent: false })
        const refresh = await ports.refreshCatalog({ workspaceId: request.workspaceId, requestId: request.requestId, selectedModelId: request.selectedModelId, enabledModelIds: gate.enabledModelIds, signal })
        const stored = { ...refresh, fresh: refresh.fresh && refresh.source === 'live' }
        await ports.store.saveCatalog(stored, new Date().toISOString())
        return stored
    }
    if (request.action === 'usage') {
        const gate = await authorityOf(ports, request.workspaceId, request.connectionId, launchNonce, signal)
        if ('status' in gate) return gate
        if (request.refresh) {
            if (!ports.refreshLimits) return unavailable('OpenCode usage refresh is not mounted.')
            const windows = await ports.refreshLimits({ workspaceId: request.workspaceId, connectionId: request.connectionId, apiKey: gate.apiKey, signal })
            if (windows?.length) {
                const record = { windows, capturedAt: new Date().toISOString() }
                await ports.store.saveLimits(request.workspaceId, request.connectionId, record)
                return { ...record, fresh: true as const }
            }
        }
        const saved = await ports.store.readLimits(request.workspaceId, request.connectionId)
        return { windows: saved?.windows ?? [], capturedAt: saved?.capturedAt ?? null, fresh: false as const }
    }
    if (request.action === 'enable') {
        const gate = await authorityOf(ports, request.workspaceId, request.connectionId, launchNonce, signal)
        if ('status' in gate) return gate
        const catalog = await ports.store.readCatalog(request.workspaceId) ?? snapshotView(request.workspaceId, 'enable', request.defaultModelId)
        const problem = desktopOpencodeEnableProblem({ enabledModelIds: request.enabledModelIds, defaultModelId: request.defaultModelId, consoleEnabled: request.consoleEnabled, knownIds: catalog.models.map(model => model.id) })
        return problem ? { ok: false, problem } : { ok: true }
    }

    const dispatch = request.dispatch
    const gate = await authorityOf(ports, dispatch.workspaceId, dispatch.connectionId, launchNonce, signal)
    if ('status' in gate) return gate
    if (gate.connectionRevision !== dispatch.connectionRevision) return desktopOpencodeResultSchema.parse({ status: 'refused', code: 'replaced', message: 'OpenCode connection changed. Reload it before sending.', sent: false })
    if (dispatch.modelId.startsWith('console/') && !dispatch.consoleEnabled) return desktopOpencodeResultSchema.parse({ status: 'refused', code: 'console', message: 'Console stays off until you switch it on.', sent: false })
    const problem = gate.apiKey ? desktopOpencodeKeyProblem(gate.apiKey) : 'This OpenCode connection has no key. Add it again in AI providers.'
    if (problem) return desktopOpencodeResultSchema.parse({ status: 'refused', code: 'credential', message: problem, sent: false })
    if (!ports.execute) return unavailable('OpenCode execution is not mounted.')

    const digest = digestOf(dispatch, request.prompt ?? null)
    const key = { workspaceId: dispatch.workspaceId, connectionId: dispatch.connectionId, runId: dispatch.runId, requestId: dispatch.requestId }
    const existing = await ports.store.readCall(key)
    if (existing) {
        if (existing.digest !== digest) throw new DesktopOpencodePublishError(409, 'Tool call identity was reused')
        return existing.result ?? desktopOpencodeResultSchema.parse({ status: 'unknown', code: 'transport', message: 'OpenCode already claimed this request. It will not be sent again.', sent: true })
    }
    if (signal?.aborted) return desktopOpencodeResultSchema.parse({ status: 'refused', code: 'cancelled', message: 'OpenCode was stopped before the request was sent.', sent: false })
    const now = new Date().toISOString()
    const claimed = await ports.store.claim({ ...key, digest, phase: 'claimed', result: null, createdAt: now, updatedAt: now })
    if (!claimed.inserted) {
        return claimed.row.result ?? desktopOpencodeResultSchema.parse({ status: 'unknown', code: 'transport', message: 'OpenCode already claimed this request. It will not be sent again.', sent: true })
    }
    const again = await authorityOf(ports, dispatch.workspaceId, dispatch.connectionId, launchNonce, signal)
    if ('status' in again || again.connectionRevision !== dispatch.connectionRevision || again.launchNonce !== gate.launchNonce) {
        const outcome = desktopOpencodeResultSchema.parse({ status: 'refused', code: 'replaced', message: 'OpenCode connection changed before the request was sent.', sent: false })
        await ports.store.finish(key, digest, outcome, new Date().toISOString())
        return outcome
    }
    if (signal?.aborted) {
        const outcome = desktopOpencodeResultSchema.parse({ status: 'refused', code: 'cancelled', message: 'OpenCode was stopped before the request was sent.', sent: false })
        await ports.store.finish(key, digest, outcome, new Date().toISOString())
        return outcome
    }
    const consoleLocked = dispatch.modelId.startsWith('console/') && !again.consoleEnabled
    if (consoleLocked || !again.enabledModelIds.includes(dispatch.modelId)) {
        const outcome = desktopOpencodeResultSchema.parse({ status: 'refused', sent: false,
            code: consoleLocked ? 'console' : 'grant',
            message: consoleLocked ? 'Console stays off until you switch it on.' : 'Choose a model this connection has switched on.' })
        await ports.store.finish(key, digest, outcome, new Date().toISOString())
        return outcome
    }
    let outcome: DesktopOpencodeResult
    try {
        outcome = await ports.execute({ dispatch, apiKey: again.apiKey, prompt: request.prompt, signal, enabledModelIds: again.enabledModelIds })
    } catch (error) {
        const message = error instanceof DesktopOpencodeStoreError ? error.message : error instanceof Error && error.message ? error.message : 'OpenCode did not answer.'
        outcome = desktopOpencodeResultSchema.parse({ status: 'unknown', code: 'transport', message: message.slice(0, 500), sent: true })
    }
    await ports.store.finish(key, digest, outcome, new Date().toISOString())
    return outcome
}

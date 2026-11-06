import {
    desktopApiConnectionCatalogSchema, desktopApiRemovalPlanSchema, desktopApiMutationResultSchema,
    desktopApiCanonicalJson, type DesktopApiConnectionCatalog, type DesktopApiConnectionProvider,
    type DesktopApiConnectionView, type DesktopApiMutationResult, type DesktopApiRemovalPlan,
    type DesktopApiSelectInput, type DesktopWorkspaceId,
} from '@rerun/contracts'
import { sendApiConnectionOperation, type ApiConnectionsApi, type ApiConnectionOperation } from './client'

export type ApiConnectionsPage = { kind: 'list' } | { kind: 'add'; provider: DesktopApiConnectionProvider } | { kind: 'detail'; connectionId: string }
export type ApiSelectionContext = Pick<DesktopApiSelectInput, 'source' | 'runId' | 'sessionId'>
export type ApiConnectionDraft = { name: string; secret: string; modelId: string; revision?: string; dirty: boolean }
export type ApiConnectionsState = {
    catalog: DesktopApiConnectionCatalog | null; page: ApiConnectionsPage
    loading: boolean; busy: boolean; error: string; notice: string
    uncertain: { requestId: string; kind: ApiConnectionOperation['kind'] } | null
}

export class ApiConnectionsSession {
    private state: ApiConnectionsState = { catalog: null, page: { kind: 'list' }, loading: false, busy: false, error: '', notice: '', uncertain: null }
    private listeners = new Set<() => void>()
    private drafts = new Map<string, ApiConnectionDraft>()
    private attempt: ApiConnectionOperation | null = null
    private readController?: AbortController
    private writeController?: AbortController
    private generation = 0
    private writeGeneration = 0
    private closed = false
    constructor(readonly workspaceId: DesktopWorkspaceId, private api: ApiConnectionsApi, private currentWorkspace: () => DesktopWorkspaceId | null) {}
    snapshot = () => this.state
    subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
    current = () => !this.closed && this.currentWorkspace() === this.workspaceId
    private publish(patch: Partial<ApiConnectionsState>) { if (this.current()) { this.state = { ...this.state, ...patch }; for (const listener of this.listeners) listener() } }
    connection(id: string) { return this.state.catalog?.connections.find(connection => connection.connectionId === id) }
    navigate(page: ApiConnectionsPage) {
        if (!this.current() || this.state.busy) return
        this.publish({ page, error: '', notice: '' })
    }
    draft(key: string, seed: Partial<ApiConnectionDraft> = {}): ApiConnectionDraft {
        let value = this.drafts.get(key)
        if (!value || !value.dirty && value.revision !== seed.revision) {
            value = { name: '', secret: '', modelId: '', dirty: false, ...seed }; this.drafts.set(key, value)
        }
        return value
    }
    changeDraft(key: string, patch: Partial<Pick<ApiConnectionDraft, 'name' | 'secret' | 'modelId'>>) {
        if (!this.current() || this.state.busy || this.state.uncertain) return
        this.drafts.set(key, { ...(this.drafts.get(key) ?? this.draft(key)), ...patch, dirty: true }); this.publish({ error: '', notice: '' })
    }
    resetDraft(key: string) { if (!this.state.busy && !this.state.uncertain) { this.drafts.delete(key); this.publish({ error: '' }) } }
    reviewDraftRevision(key: string, connection: DesktopApiConnectionView) {
        if (!this.current() || this.state.busy || this.state.uncertain || this.connection(connection.connectionId)?.revision !== connection.revision) return
        const draft = this.drafts.get(key)
        if (draft) { this.drafts.set(key, { ...draft, revision: connection.revision }); this.publish({ error: '' }) }
    }
    async refresh() {
        if (!this.current() || this.state.busy) return
        this.readController?.abort()
        const controller = new AbortController(), generation = ++this.generation
        this.readController = controller; this.publish({ loading: true, error: '' })
        try {
            const parsed = desktopApiConnectionCatalogSchema.parse(await this.api.list(this.workspaceId, controller.signal))
            if (parsed.workspaceId !== this.workspaceId || parsed.connections.some(c => c.workspaceId !== this.workspaceId) || new Set(parsed.connections.map(c => c.connectionId)).size !== parsed.connections.length) throw Error()
            if (!controller.signal.aborted && generation === this.generation) this.publish({ catalog: parsed, loading: false })
        } catch { if (!controller.signal.aborted && generation === this.generation) this.publish({ loading: false, error: 'Could not load the connections. Try again.' }) }
    }
    async review(connection: DesktopApiConnectionView, signal: AbortSignal): Promise<DesktopApiRemovalPlan> {
        const page = this.state.page
        if (!this.current() || page.kind !== 'detail' || page.connectionId !== connection.connectionId || this.connection(connection.connectionId)?.revision !== connection.revision) throw Error('This connection changed. Reload it before removal.')
        const plan = desktopApiRemovalPlanSchema.parse(await this.api.removalPlan(this.workspaceId, connection.connectionId, signal))
        signal.throwIfAborted()
        if (!this.current() || this.state.page.kind !== 'detail' || this.state.page.connectionId !== connection.connectionId || this.connection(connection.connectionId)?.revision !== connection.revision || plan.workspaceId !== this.workspaceId || plan.connectionId !== connection.connectionId || plan.connectionRevision !== connection.revision
            || plan.connection.workspaceId !== this.workspaceId || plan.connection.connectionId !== connection.connectionId || plan.connection.revision !== connection.revision
            || plan.pendingRuns.some(run => run.connectionId !== connection.connectionId) || plan.preservedConnectionIds.includes(connection.connectionId)) throw Error('This connection changed. Reload the removal review.')
        return plan
    }
    async removeReviewed(connection: DesktopApiConnectionView, reviewed: DesktopApiRemovalPlan, signal: AbortSignal): Promise<{ changed: DesktopApiRemovalPlan } | { result: DesktopApiMutationResult | null }> {
        const fresh = await this.review(connection, signal)
        if (desktopApiCanonicalJson(fresh) !== desktopApiCanonicalJson(reviewed)) return { changed: fresh }
        if (!fresh.canRemove) return { changed: fresh }
        return { result: await this.execute({ kind: 'remove', input: { requestId: crypto.randomUUID(), workspaceId: this.workspaceId, connectionId: fresh.connectionId, expectedRevision: fresh.connectionRevision } }) }
    }
    async execute(operation: ApiConnectionOperation): Promise<DesktopApiMutationResult | null> {
        if (!this.current() || this.state.busy || this.attempt || operation.input.workspaceId !== this.workspaceId) return null
        const page = this.state.page
        if (operation.kind === 'create' ? page.kind !== 'add' || page.provider !== operation.input.provider
            : operation.kind === 'select' ? page.kind !== 'list'
                : page.kind !== 'detail' || page.connectionId !== operation.input.connectionId) return null
        if (operation.kind !== 'create' && this.connection(operation.input.connectionId)?.revision !== operation.input.expectedRevision) {
            this.publish({ error: 'This connection changed. Reload its saved values before saving.' }); return null
        }
        this.attempt = structuredClone(operation)
        return this.dispatch()
    }
    async retry() { if (!this.current() || this.state.busy || !this.attempt) return null; return this.dispatch() }
    private async dispatch(): Promise<DesktopApiMutationResult | null> {
        const attempt = this.attempt!
        const generation = ++this.writeGeneration
        const page = desktopApiCanonicalJson(this.state.page)
        this.readController?.abort(); ++this.generation
        const controller = new AbortController(); this.writeController = controller
        this.publish({ busy: true, loading: false, error: '', notice: '' })
        try {
            const result = desktopApiMutationResultSchema.parse(await sendApiConnectionOperation(this.api, attempt, controller.signal))
            const receipt = result.receipt
            if (receipt.requestId !== attempt.input.requestId || receipt.workspaceId !== this.workspaceId || receipt.kind !== attempt.kind || receipt.status !== result.status
                || attempt.kind !== 'create' && receipt.connectionId !== attempt.input.connectionId
                || result.connection && (result.connection.workspaceId !== this.workspaceId || result.connection.connectionId !== receipt.connectionId)
                || result.catalog && (result.catalog.workspaceId !== this.workspaceId || result.catalog.connections.some(c => c.workspaceId !== this.workspaceId)
                    || new Set(result.catalog.connections.map(c => c.connectionId)).size !== result.catalog.connections.length)
                || result.status === 'saved' && (attempt.kind === 'remove' ? result.connection !== null || !result.removal
                    : !result.connection || result.connection.revision !== receipt.connectionRevision)) throw Error()
            if (!this.current() || this.attempt !== attempt || generation !== this.writeGeneration) return null
            // Server receipts may record a committed effect even when its client wait was cancelled.
            if (result.status === 'uncertain') {
                this.publish({ busy: false, uncertain: { kind: attempt.kind, requestId: attempt.input.requestId }, error: 'The outcome is not confirmed. Retry this exact request; do not create a replacement request.' })
                return result
            }
            this.attempt = null
            const secret = 'secret' in attempt.input ? attempt.input.secret : ''
            const message = secret ? receipt.message.split(secret).join('[redacted]') : receipt.message
            if (result.status === 'refused') { this.publish({ busy: false, uncertain: null, error: message }); return result }
            if (attempt.kind === 'create') this.drafts.delete(`add:${attempt.input.provider}`)
            if (attempt.kind === 'credential') this.drafts.delete(`key:${attempt.input.connectionId}`)
            if (attempt.kind === 'rename') this.drafts.delete(`name:${attempt.input.connectionId}`)
            if (attempt.kind === 'models') this.drafts.delete(`model:${attempt.input.connectionId}`)
            this.publish({ busy: false, uncertain: null,
                ...(result.catalog && { catalog: result.catalog }),
                notice: attempt.kind === 'credential' || attempt.kind === 'create' ? 'API key saved. The provider has not been tested.' : message,
                ...(page === desktopApiCanonicalJson(this.state.page) && attempt.kind === 'create' && result.connection && { page: { kind: 'detail' as const, connectionId: result.connection.connectionId } }),
                ...(attempt.kind === 'remove' && { page: { kind: 'list' as const } }),
            })
            if (!result.catalog) await this.refresh()
            return result
        } catch {
            if (this.current() && this.attempt === attempt && generation === this.writeGeneration) this.publish({ busy: false, uncertain: { kind: attempt.kind, requestId: attempt.input.requestId }, error: 'Could not confirm this request. Retry the same request to reconcile it.' })
            return null
        }
    }
    suspend() {
        ++this.generation; ++this.writeGeneration; this.readController?.abort(); this.writeController?.abort()
        this.state = { ...this.state, busy: false, loading: false,
            ...(this.attempt && { uncertain: { kind: this.attempt.kind, requestId: this.attempt.input.requestId }, error: 'The connection request was interrupted. Retry the same request to reconcile it.' }) }
    }
    close() {
        this.closed = true; ++this.generation; ++this.writeGeneration; this.readController?.abort(); this.writeController?.abort()
        this.drafts.clear(); this.attempt = null; this.listeners.clear()
    }
}

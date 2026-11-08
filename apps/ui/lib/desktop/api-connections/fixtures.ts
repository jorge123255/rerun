import type { DesktopApiConnectionView, DesktopApiConnectionCatalog, DesktopApiRemovalPlan, DesktopApiMutationResult } from '@rerun/contracts'
import type { ApiConnectionOperation, ApiConnectionsApi } from './client'
export const FIXTURE_REQUEST_ID = '00000000-0000-4000-8000-000000000001'
export const connectionFixture = (suffix = 'one', patch: Partial<DesktopApiConnectionView> = {}): DesktopApiConnectionView => ({
    version: 1, workspaceId: 1, connectionId: `cnx_fixture-${suffix}`, revision: `rev_fixture-${suffix}`,
    provider: 'openai', name: `OpenAI ${suffix}`, models: ['gpt-fixture'], extraModels: [],
    connected: true, credentialRejected: false, createdAt: '2026-11-06T12:00:00.000Z', ...patch,
})
export const catalogFixture = (): DesktopApiConnectionCatalog => ({ version: 1, workspaceId: 1, connections: [connectionFixture(), connectionFixture('two')], default: { connectionId: 'codex-existing', model: 'codex-fixture' } })
export function planFixture(connection = connectionFixture()): DesktopApiRemovalPlan {
    return { version: 1, workspaceId: 1, connectionId: connection.connectionId, connectionRevision: connection.revision, connection,
        usage: { agents: [{ id: 'coworker-a', name: 'Writer' }], automations: [{ agentId: 'coworker-a', kind: 'schedule', slug: 'daily' }], isBoxDefault: true },
        pendingRuns: [], preservedConnectionIds: [connectionFixture('two').connectionId], canRemove: true }
}
export function resultFixture(operation: ApiConnectionOperation, catalog: DesktopApiConnectionCatalog, status: 'saved' | 'refused' | 'uncertain' = 'saved'): DesktopApiMutationResult {
    const id = operation.kind === 'create' ? 'cnx_fixture-created' : operation.input.connectionId
    const base = catalog.connections.find(c => c.connectionId === id) ?? connectionFixture('created')
    const connection = operation.kind === 'remove' ? null : { ...base, connectionId: id, revision: 'rev_fixture-saved',
        ...(operation.kind === 'create' && { name: operation.input.name, provider: operation.input.provider, models: operation.input.models, extraModels: operation.input.extraModels }),
        ...(operation.kind === 'rename' && { name: operation.input.name }),
        ...(operation.kind === 'models' && { models: operation.input.models, extraModels: operation.input.extraModels }) }
    const nextCatalog = { ...catalog, connections: [...catalog.connections.filter(c => c.connectionId !== id), ...(connection ? [connection] : [])],
        ...(operation.kind === 'select' && { default: { connectionId: id, model: operation.input.model } }) }
    return { status, recovered: false, connection,
        receipt: { version: 1, requestId: operation.input.requestId, kind: operation.kind, status, workspaceId: 1,
            connectionId: id, connectionRevision: 'rev_fixture-saved', fingerprint: 'a'.repeat(64), message: 'Saved fixture operation',
            createdAt: '2026-11-06T12:00:00.000Z', updatedAt: '2026-11-06T12:00:00.000Z' },
        catalog: nextCatalog, ...(operation.kind === 'remove' && { removal: { released: planFixture().usage, preservedConnectionIds: planFixture().preservedConnectionIds } }) }
}
export function apiFixture(catalog = catalogFixture()): ApiConnectionsApi {
    const mutate = async (operation: ApiConnectionOperation) => resultFixture(operation, catalog)
    return { list: async () => catalog, removalPlan: async (_workspace, id) => planFixture(catalog.connections.find(c => c.connectionId === id)!),
        create: input => mutate({ kind: 'create', input }), rename: input => mutate({ kind: 'rename', input }), models: input => mutate({ kind: 'models', input }),
        credential: input => mutate({ kind: 'credential', input }), select: input => mutate({ kind: 'select', input }), remove: input => mutate({ kind: 'remove', input }) }
}
